-- 单用户当月配额调整（docs/plans/admin-credit-quota.md「单个用户当月怎么调」）。
-- 只追加有符号差额；不修改 credit_grant / credit_entry / credit_account 的历史事实。
-- 时间列与其它表一致：UTC 朴素时间戳 TIMESTAMP(3)。

CREATE TABLE credit_quota_adjustment (
  id                  VARCHAR(36) PRIMARY KEY,
  user_id             BIGINT NOT NULL,
  period              VARCHAR(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  mode                VARCHAR(16) NOT NULL CHECK (mode IN ('increase', 'decrease', 'target')),
  credits             BIGINT NOT NULL CHECK (credits <> 0),
  reason              VARCHAR(500) NOT NULL CHECK (length(btrim(reason)) > 0),
  operator_id         BIGINT NOT NULL,
  request_id          VARCHAR(128) NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  before_credits      BIGINT NOT NULL CHECK (before_credits >= 0),
  after_credits       BIGINT NOT NULL CHECK (after_credits >= 0),
  create_time         TIMESTAMP(3) NOT NULL
);
-- 同一次调整意图的重试幂等；同键异载荷由 request_fingerprint 拒绝。
CREATE UNIQUE INDEX uk_credit_quota_adjust_request
  ON credit_quota_adjustment (user_id, request_id);
CREATE INDEX idx_credit_quota_adjust_period
  ON credit_quota_adjustment (period, user_id);
