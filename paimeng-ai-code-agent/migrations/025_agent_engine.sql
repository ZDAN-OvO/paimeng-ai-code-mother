-- PR-01：AI SDK 执行引擎的地基表。旧 pi-durable 表保持只读兼容，GENERATION_ENGINE 默认仍是 harness。
-- 转录直接存 AI SDK UIMessage 的 parts，不另造中间格式；本迁移只建表，不迁移旧数据（PR-06 负责）。

CREATE TABLE agent_conversation (
  id          BIGSERIAL PRIMARY KEY,
  app_id      BIGINT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  CONSTRAINT uk_agent_conversation_app UNIQUE (app_id)
);

CREATE TABLE agent_run (
  run_id            VARCHAR(64) PRIMARY KEY,
  app_id            BIGINT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  generation_id     VARCHAR(36) NOT NULL,
  conversation_id   BIGINT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  status            VARCHAR(16) NOT NULL,
  cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_hook_token VARCHAR(128),
  error             TEXT,
  create_time       TIMESTAMP(3) NOT NULL,
  update_time       TIMESTAMP(3) NOT NULL,
  finished_at       TIMESTAMP(3),
  CONSTRAINT agent_run_status CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX idx_agent_run_generation ON agent_run(generation_id);
CREATE INDEX idx_agent_run_status ON agent_run(status, update_time);

CREATE TABLE agent_message (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  run_id          VARCHAR(64),
  seq             INTEGER NOT NULL,
  role            VARCHAR(16) NOT NULL,
  parts           JSONB NOT NULL,
  input_id        VARCHAR(36),
  create_time     TIMESTAMP(3) NOT NULL,
  update_time     TIMESTAMP(3) NOT NULL,
  CONSTRAINT uk_agent_message_seq UNIQUE (conversation_id, seq),
  CONSTRAINT agent_message_role CHECK (role IN ('system', 'user', 'assistant'))
);

CREATE INDEX idx_agent_message_run ON agent_message(run_id);

CREATE TABLE agent_effect (
  run_id      VARCHAR(64) NOT NULL,
  tool_call_id VARCHAR(128) NOT NULL,
  tool_name   VARCHAR(64) NOT NULL,
  replay      VARCHAR(8) NOT NULL,
  status      VARCHAR(16) NOT NULL,
  result_json JSONB,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (run_id, tool_call_id),
  CONSTRAINT agent_effect_replay CHECK (replay IN ('safe', 'unsafe')),
  CONSTRAINT agent_effect_status CHECK (status IN ('started', 'completed', 'failed', 'cancelled'))
);

-- 输入水位从「接口受理 / SDK 投稿 / 进入上下文」收敛到产品表：queued 表示已受理，resolved 表示已写入 agent_message。
ALTER TABLE generation_input ADD COLUMN run_id VARCHAR(64);
ALTER TABLE generation_input ADD COLUMN message_id VARCHAR(36);

CREATE INDEX idx_generation_input_run ON generation_input(run_id);
