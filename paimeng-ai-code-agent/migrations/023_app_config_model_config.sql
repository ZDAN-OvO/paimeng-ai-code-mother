-- 模型配置 JSON 文档（ADR-0007）：提供商、模型、价格版本与槽位分配收进一行 JSONB。
-- 这里只建承载表；旧表 model_provider / model_alias / model_config_state / credit_rate_card
-- 保留一个发布周期供回滚，运行期不再读写。回填工具见 scripts/db/backfill-model-config.ts。
CREATE TABLE app_config (
  key           TEXT PRIMARY KEY,
  revision      BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  refresh_epoch BIGINT NOT NULL DEFAULT 0 CHECK (refresh_epoch >= 0),
  value         JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at    TIMESTAMP(3) NOT NULL
);

INSERT INTO app_config (key, revision, refresh_epoch, value, updated_at)
VALUES (
  'model_config',
  0,
  0,
  '{"schemaVersion":1,"providers":[],"slots":[],"legacyPrices":[]}'::jsonb,
  timezone('UTC', now())
);
