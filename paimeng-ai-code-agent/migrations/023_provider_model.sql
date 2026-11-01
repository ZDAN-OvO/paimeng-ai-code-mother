-- 提供商模型与稳定身份（docs/plans/provider-model-billing.md「数据分层与不变量」）。
-- 只新增表与可空引用列，不改既有列、不回写历史数据：旧程序在迁移后仍可运行，
-- 槽位、费率与步骤的关联由后续回填工具显式建立，本迁移不产生任何扣费或配置变更。
-- 时间列与其它表一致，为 UTC 朴素时间戳（TIMESTAMP(3)）。
-- 同一请求模型名在不同提供商下是两条记录；同一提供商内按原始字符串唯一（区分大小写）。

CREATE TABLE provider_model (
  id                  BIGINT PRIMARY KEY,
  provider_id         VARCHAR(64) NOT NULL REFERENCES model_provider (id),
  upstream_model_name VARCHAR(256) NOT NULL,
  display_name        VARCHAR(128) NOT NULL,
  capabilities        JSONB NOT NULL,
  compatibility       JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled             INTEGER NOT NULL DEFAULT 0,
  create_time         TIMESTAMP(3) NOT NULL,
  update_time         TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX uk_provider_model_upstream ON provider_model (provider_id, upstream_model_name);
CREATE INDEX idx_provider_model_provider ON provider_model (provider_id, enabled);

-- 槽位引用模型；旧行保持 NULL，由回填工具在受控窗口内关联。
ALTER TABLE model_alias ADD COLUMN provider_model_id BIGINT REFERENCES provider_model (id);
CREATE INDEX idx_model_alias_provider_model ON model_alias (provider_model_id);

-- 费率版本引用模型。旧历史行保留原主键与 provider_id/model_name，不重写、不猜关联；
-- 新写入必须带模型 ID，所以 (provider_model_id, effective_from) 在非空值上唯一。
ALTER TABLE credit_rate_card ADD COLUMN provider_model_id BIGINT REFERENCES provider_model (id);
CREATE UNIQUE INDEX uk_credit_rate_card_provider_model_version
  ON credit_rate_card (provider_model_id, effective_from)
  WHERE provider_model_id IS NOT NULL;
CREATE INDEX idx_credit_rate_card_provider_model
  ON credit_rate_card (provider_model_id, effective_from DESC)
  WHERE provider_model_id IS NOT NULL;

-- 运行步骤固定配置身份；上游响应名继续写在 upstream_provider / upstream_model_id。
-- 旧步骤保持 NULL，历史计费走原有字符串兼容分支。
ALTER TABLE generation_step ADD COLUMN provider_model_id BIGINT REFERENCES provider_model (id);
CREATE INDEX idx_generation_step_provider_model
  ON generation_step (provider_model_id)
  WHERE provider_model_id IS NOT NULL;
