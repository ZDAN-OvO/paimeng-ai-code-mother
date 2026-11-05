-- App runtime（docs/plans/app-runtime.md PR-02）。
-- 一个 App 一行：容器的持久身份、dev server 端口、挂载的源码根、镜像身份与最后活动时间。
-- 容器本身由 supervisor 启停；本表只记录「平台认为它在哪」，平台重启后按容器标签对账。
-- 时间列与其它表一致：UTC 朴素时间戳 TIMESTAMP(3)。

CREATE TABLE app_runtime (
  app_id           BIGINT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  run_id           VARCHAR(16) NOT NULL,
  container_id     VARCHAR(64) NOT NULL,
  container_name   VARCHAR(128) NOT NULL,
  port             INTEGER NOT NULL CHECK (port > 0 AND port <= 65535),
  image_identity   VARCHAR(256) NOT NULL,
  workspace_root   TEXT NOT NULL,
  status           VARCHAR(16) NOT NULL CHECK (status IN ('starting', 'ready', 'stopping', 'failed', 'stopped')),
  lock_digest      CHAR(64),
  last_error       VARCHAR(1000),
  last_activity_at TIMESTAMP(3) NOT NULL,
  create_time      TIMESTAMP(3) NOT NULL,
  update_time      TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (app_id, run_id)
);

CREATE UNIQUE INDEX uk_app_runtime_container ON app_runtime (container_name);
CREATE INDEX idx_app_runtime_activity ON app_runtime (last_activity_at);
CREATE INDEX idx_app_runtime_status ON app_runtime (status);
