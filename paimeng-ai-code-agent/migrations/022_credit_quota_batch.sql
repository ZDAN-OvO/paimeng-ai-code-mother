-- Admin 月度配额批量发放（docs/plans/admin-credit-quota.md「管理员月度发放」）。
-- 批次固定预览时的账期、范围与逐用户策略快照；item 是逐用户回执，重试只重跑失败项。
-- 时间列与其它表一致：UTC 朴素时间戳 TIMESTAMP(3)。

CREATE TABLE credit_quota_batch (
  id                VARCHAR(36) PRIMARY KEY,
  period            VARCHAR(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  scope             VARCHAR(16) NOT NULL CHECK (scope IN ('pending', 'users')),
  selection         JSONB NOT NULL,
  preview_token     VARCHAR(64) NOT NULL,
  preview_fingerprint VARCHAR(64) NOT NULL,
  status            VARCHAR(16) NOT NULL CHECK (status IN ('previewed', 'running', 'completed', 'failed', 'superseded')),
  target_count      INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  pending_count     INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  granted_count     INTEGER NOT NULL DEFAULT 0 CHECK (granted_count >= 0),
  zero_count        INTEGER NOT NULL DEFAULT 0 CHECK (zero_count >= 0),
  skipped_count     INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count      INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  total_credits     BIGINT NOT NULL DEFAULT 0,
  issued_credits    BIGINT NOT NULL DEFAULT 0,
  scope_total       INTEGER NOT NULL DEFAULT 0 CHECK (scope_total >= 0),
  truncated         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        BIGINT NOT NULL,
  create_time       TIMESTAMP(3) NOT NULL,
  started_time      TIMESTAMP(3),
  finished_time     TIMESTAMP(3)
);
CREATE INDEX idx_credit_quota_batch_time ON credit_quota_batch (create_time DESC);

CREATE TABLE credit_quota_batch_item (
  batch_id       VARCHAR(36) NOT NULL,
  user_id        BIGINT NOT NULL,
  base_credits   BIGINT NOT NULL CHECK (base_credits >= 0),
  policy_source  VARCHAR(16) NOT NULL CHECK (policy_source IN ('global', 'user', 'legacy', 'fallback')),
  policy_version INTEGER,
  policy_id      VARCHAR(36),
  status         VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'granted', 'skipped', 'failed')),
  issue_id       VARCHAR(36),
  reason         VARCHAR(500),
  update_time    TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (batch_id, user_id)
);
CREATE INDEX idx_credit_quota_batch_item_status ON credit_quota_batch_item (batch_id, status);
