-- 可配置月度配额：策略版本与每用户账期发放事实（docs/plans/admin-credit-quota.md「账本、数据与查询设计」）。
-- 只新增表与回填事实，不修改既有 credit_grant / credit_account 定义，也不回改已发放月份。
-- 时间列与其它表一致：UTC 朴素时间戳 TIMESTAMP(3)。

-- 策略版本：只追加。global 是默认值，user 可为覆盖或显式继承。
-- effective_period 是北京自然月 YYYY-MM；解析时取 <= 目标账期的最大 period、再取最大 revision。
CREATE TABLE credit_quota_policy (
  id               VARCHAR(36) PRIMARY KEY,
  scope            VARCHAR(16) NOT NULL CHECK (scope IN ('global', 'user')),
  user_id          BIGINT,
  effective_period VARCHAR(7) NOT NULL CHECK (effective_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  mode             VARCHAR(16) NOT NULL CHECK (mode IN ('inherit', 'override')),
  credits          BIGINT CHECK (credits IS NULL OR credits >= 0),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  note             TEXT,
  created_by       BIGINT,
  create_time      TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_quota_policy_scope_user CHECK ((scope = 'global') = (user_id IS NULL)),
  CONSTRAINT credit_quota_policy_mode CHECK (
    (scope = 'global' AND mode = 'override' AND credits IS NOT NULL)
    OR (scope = 'user' AND (
      (mode = 'inherit' AND credits IS NULL)
      OR (mode = 'override' AND credits IS NOT NULL)
    ))
  )
);
CREATE UNIQUE INDEX uk_credit_quota_policy_global
  ON credit_quota_policy (effective_period, revision) WHERE scope = 'global';
CREATE UNIQUE INDEX uk_credit_quota_policy_user
  ON credit_quota_policy (user_id, effective_period, revision) WHERE scope = 'user';
CREATE INDEX idx_credit_quota_policy_lookup
  ON credit_quota_policy (scope, user_id, effective_period DESC, revision DESC);

-- 每用户每账期一条基础发放事实。金额为 0 也记一行，不伪造零金额 grant；
-- status=granted 且金额 > 0 时必须关联原 monthly_quota grant。
CREATE TABLE credit_quota_issue (
  id             VARCHAR(36) PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  period         VARCHAR(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  base_credits   BIGINT NOT NULL CHECK (base_credits >= 0),
  status         VARCHAR(16) NOT NULL CHECK (status IN ('granted', 'failed')),
  policy_source  VARCHAR(16) NOT NULL CHECK (policy_source IN ('global', 'user', 'legacy', 'fallback')),
  policy_version INTEGER,
  policy_id      VARCHAR(36),
  grant_id       VARCHAR(36),
  reason         TEXT,
  create_time    TIMESTAMP(3) NOT NULL,
  update_time    TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_quota_issue_grant CHECK (status <> 'granted' OR base_credits = 0 OR grant_id IS NOT NULL)
);
CREATE UNIQUE INDEX uk_credit_quota_issue_period ON credit_quota_issue (user_id, period);
CREATE INDEX idx_credit_quota_issue_period_status ON credit_quota_issue (period, status);

-- 迁移回填：已有 monthly_quota grant 就是对应账期的基础发放事实，金额原样保留。
-- 当前标准后来变成 500 也不能反过来改历史行；这里只把既有事实关联起来。
INSERT INTO credit_quota_issue (
  id, user_id, period, base_credits, status, policy_source, policy_version,
  policy_id, grant_id, reason, create_time, update_time
)
SELECT
  gen_random_uuid()::text, g.user_id, g.period, g.credits, 'granted', 'legacy', 0,
  NULL, g.id, '迁移回填：历史 monthly_quota grant', g.create_time, g.create_time
FROM credit_grant g
WHERE g.source = 'monthly_quota' AND g.period IS NOT NULL
ON CONFLICT (user_id, period) DO NOTHING;
