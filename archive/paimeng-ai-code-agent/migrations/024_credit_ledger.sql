-- 单账本：一张追加式 credit_ledger 取代 grant/entry/account 与配额四件套。
-- 本迁移只新增与回填，不删旧表；旧表在 025 里删除之前一直完整可读，作为回滚依据。

CREATE TABLE credit_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  origin        VARCHAR(16) NOT NULL,
  credits       BIGINT NOT NULL,
  period        VARCHAR(7),
  expires_at    TIMESTAMP(3),
  charge_id     VARCHAR(36),
  reversal_of   BIGINT,
  reason        TEXT,
  operator_id   BIGINT,
  request_id    VARCHAR(128),
  ref           VARCHAR(128),
  create_time   TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_ledger_kind CHECK (kind IN ('quota', 'topup', 'grant', 'consume', 'refund', 'expire')),
  CONSTRAINT credit_ledger_origin CHECK (origin IN ('rule', 'manual', 'payment', 'charge', 'expiry', 'reversal')),
  -- 只允许「规则发放 0」这种回执行是 0：账本里不接受其他静默的零金额。
  CONSTRAINT credit_ledger_nonzero CHECK (credits <> 0 OR (kind = 'quota' AND origin = 'rule')),
  -- 限时积分必须能说出属于哪个账期、什么时候到期；长期积分两者都为空。
  CONSTRAINT credit_ledger_bucket CHECK (
    (kind = 'quota' AND period IS NOT NULL AND expires_at IS NOT NULL)
    OR (kind IN ('topup', 'grant') AND period IS NULL AND expires_at IS NULL)
    OR (kind IN ('consume', 'refund', 'expire') AND (period IS NULL) = (expires_at IS NULL))
  ),
  CONSTRAINT credit_ledger_charge CHECK (
    CASE WHEN kind IN ('consume', 'refund') THEN charge_id IS NOT NULL ELSE charge_id IS NULL END
  )
);

CREATE INDEX idx_credit_ledger_user_time ON credit_ledger (user_id, create_time, id);
CREATE INDEX idx_credit_ledger_user_period ON credit_ledger (user_id, period);
CREATE INDEX idx_credit_ledger_charge ON credit_ledger (charge_id);
CREATE INDEX idx_credit_ledger_request ON credit_ledger (request_id);

-- 每人每期最多一条规则发放；0 额度也是一种「已处理」。
CREATE UNIQUE INDEX uk_credit_ledger_rule ON credit_ledger (user_id, period)
  WHERE kind = 'quota' AND origin = 'rule';
-- 账期边界的过期行只写一条；冲正引发的过期用 origin='reversal'，不受这条约束。
CREATE UNIQUE INDEX uk_credit_ledger_expire ON credit_ledger (user_id, period)
  WHERE kind = 'expire' AND origin = 'expiry';
CREATE UNIQUE INDEX uk_credit_ledger_request ON credit_ledger (user_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX uk_credit_ledger_reversal ON credit_ledger (reversal_of)
  WHERE reversal_of IS NOT NULL;
CREATE UNIQUE INDEX uk_credit_ledger_ref ON credit_ledger (ref)
  WHERE ref IS NOT NULL;

-- 锁点与快照：available 永远等于账本求和（含已写出的过期行），next_expiry_at 之后快照作废。
CREATE TABLE credit_balance (
  user_id         BIGINT PRIMARY KEY,
  available       BIGINT NOT NULL DEFAULT 0,
  next_expiry_at  TIMESTAMP(3),
  update_time     TIMESTAMP(3) NOT NULL
);

-- 批量与扫描的摘要日志。不是批次表：没有预览 token、没有逐用户回执、不参与幂等。
CREATE TABLE credit_operation (
  id             VARCHAR(36) PRIMARY KEY,
  kind           VARCHAR(16) NOT NULL,
  request_id     VARCHAR(128) NOT NULL,
  period         VARCHAR(7),
  operator_id    BIGINT,
  target_count   INTEGER NOT NULL DEFAULT 0,
  issued_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  credits        BIGINT NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL,
  detail         JSONB NOT NULL DEFAULT '[]'::jsonb,
  create_time    TIMESTAMP(3) NOT NULL,
  finish_time    TIMESTAMP(3),
  CONSTRAINT credit_operation_kind CHECK (kind IN ('issue_pending', 'issue_users', 'expire_sweep')),
  CONSTRAINT credit_operation_status CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);

CREATE INDEX idx_credit_operation_time ON credit_operation (create_time DESC);

-- ---- 回填 ----

-- 1. 每期规则发放：以 issue 为准（含 0 额度），迁移前没有 issue 的旧 grant 再补一条。
INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, reason, create_time)
SELECT i.user_id, 'quota', 'rule', i.base_credits, i.period,
  ((i.period || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours',
  '迁移：每月限时积分', i.create_time
FROM credit_quota_issue i
WHERE i.status = 'granted'
ON CONFLICT DO NOTHING;

INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, reason, create_time)
SELECT g.user_id, 'quota', 'rule', g.credits, g.period,
  ((g.period || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours',
  '迁移：历史月度配额', g.create_time
FROM credit_grant g
WHERE g.source = 'monthly_quota' AND g.period IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM credit_quota_issue i
    WHERE i.user_id = g.user_id AND i.period = g.period AND i.status = 'granted'
  )
ON CONFLICT DO NOTHING;

-- 2. 当月手动调整：有符号差额原样搬过来，request_id 保留幂等键。
INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, reason, operator_id, request_id, create_time)
SELECT a.user_id, 'quota', 'manual', a.credits, a.period,
  ((a.period || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours',
  a.reason, a.operator_id, a.request_id, a.create_time
FROM credit_quota_adjustment a
ON CONFLICT DO NOTHING;

-- 3. 购买与人工补偿：长期积分，来源写进 origin，支付单号进 ref。
INSERT INTO credit_ledger (user_id, kind, origin, credits, reason, request_id, ref, create_time)
SELECT g.user_id, 'topup', 'payment', g.credits, g.note, g.request_id, g.external_ref, g.create_time
FROM credit_grant g
WHERE g.source = 'purchase'
ON CONFLICT DO NOTHING;

INSERT INTO credit_ledger (user_id, kind, origin, credits, reason, operator_id, request_id, create_time)
SELECT g.user_id, 'grant', 'manual', g.credits, g.note, g.granted_by, g.request_id, g.create_time
FROM credit_grant g
WHERE g.source = 'admin_grant'
ON CONFLICT DO NOTHING;

-- 4. 账单分录：旧 credit_entry 的 pool='quota' 归到父 Charge 的北京账期，pool='balance' 是长期积分。
--    冲正行按 reversal_of 回指新行，并继承原行的 period / expires_at。
--    `ref = 'credit_entry:<旧 id>'` 既是新旧行的对应键，也让重复执行天然幂等。
INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, charge_id, reason, ref, create_time)
SELECT c.user_id, 'consume', 'charge', -e.credits,
  CASE WHEN e.pool = 'quota' THEN to_char(c.create_time + INTERVAL '8 hours', 'YYYY-MM') END,
  CASE WHEN e.pool = 'quota'
    THEN ((to_char(c.create_time + INTERVAL '8 hours', 'YYYY-MM') || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours'
  END,
  e.charge_id, e.reason, 'credit_entry:' || e.id, e.create_time
FROM credit_entry e
JOIN credit_charge c ON c.generation_id = e.charge_id
WHERE e.reversal_of IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, charge_id, reversal_of, reason, operator_id, ref, create_time)
SELECT c.user_id, 'refund', 'reversal', -e.credits, orig.period, orig.expires_at,
  e.charge_id, orig.id, e.reason, e.operator_id, 'credit_entry:' || e.id, e.create_time
FROM credit_entry e
JOIN credit_charge c ON c.generation_id = e.charge_id
JOIN credit_ledger orig ON orig.ref = 'credit_entry:' || e.reversal_of
WHERE e.reversal_of IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5. 已结束账期里还没花完的限时积分：每个用户每个账期补一条过期行。
WITH facts AS (
  SELECT user_id, period,
    COALESCE(SUM(CASE WHEN kind = 'quota' THEN credits ELSE 0 END), 0) AS issued,
    COALESCE(SUM(CASE WHEN kind IN ('consume', 'refund') THEN -credits ELSE 0 END), 0) AS consumed,
    COALESCE(SUM(CASE WHEN kind = 'expire' THEN -credits ELSE 0 END), 0) AS expired,
    BOOL_OR(kind = 'expire' AND origin = 'expiry') AS swept
  FROM credit_ledger
  WHERE period IS NOT NULL
    AND period < to_char((now() AT TIME ZONE 'UTC') + INTERVAL '8 hours', 'YYYY-MM')
  GROUP BY user_id, period
)
INSERT INTO credit_ledger (user_id, kind, origin, credits, period, expires_at, reason, create_time)
SELECT user_id, 'expire', 'expiry', -(issued - consumed - expired), period,
  ((period || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours',
  '迁移：上期未用完的限时积分',
  ((period || '-01')::date + INTERVAL '1 month')::timestamp - INTERVAL '8 hours'
FROM facts
WHERE NOT swept AND issued - consumed - expired > 0
ON CONFLICT DO NOTHING;

-- 6. 余额快照：可用额 = 账本求和；next_expiry_at = 还有剩余的最近一个到期时刻。
WITH bucket AS (
  SELECT user_id, period, expires_at, SUM(credits) AS remaining
  FROM credit_ledger
  WHERE period IS NOT NULL
  GROUP BY user_id, period, expires_at
),
totals AS (
  SELECT user_id, SUM(credits) AS available FROM credit_ledger GROUP BY user_id
)
INSERT INTO credit_balance (user_id, available, next_expiry_at, update_time)
SELECT t.user_id, t.available,
  (SELECT MIN(b.expires_at) FROM bucket b
   WHERE b.user_id = t.user_id AND b.remaining > 0 AND b.expires_at > (now() AT TIME ZONE 'UTC')),
  (now() AT TIME ZONE 'UTC')
FROM totals t
ON CONFLICT (user_id) DO UPDATE
SET available = EXCLUDED.available, next_expiry_at = EXCLUDED.next_expiry_at, update_time = EXCLUDED.update_time;
