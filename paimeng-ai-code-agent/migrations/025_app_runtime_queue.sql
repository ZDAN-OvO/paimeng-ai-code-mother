-- App runtime 容量排队（issue #144）：没有空闲槽位时，Generation 持久化为 queued 并在这里等位。
-- 一行 = 一个 App 的待启动 Generation（每 App 同时最多一条，主键就是 app_id）。
-- state：waiting 在队列里；granted 已分配到槽位、正在等这次请求把 runtime 建起来。
-- 槽位占用 = app_runtime(starting/ready) + 已 granted 但还没有 runtime 行的排队行；
-- 所以 granted 行在 runtime 行出现后就不再重复计数，可以在生成收束或 runtime 建立时删除。
-- generation_id 不建外键：先占位、后插入 generation 行（排队本身不抢写权限），
-- 请求在插入 generation 后立即把两者绑定；App 删除仍由 app_id 级联清理。
CREATE TABLE app_runtime_queue (
  app_id        BIGINT PRIMARY KEY REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36) NOT NULL,
  state         VARCHAR(16) NOT NULL CHECK (state IN ('waiting', 'granted')),
  holder        TEXT NOT NULL,
  enqueued_at   TIMESTAMP(3) NOT NULL,
  heartbeat_at  TIMESTAMP(3) NOT NULL,
  wait_deadline TIMESTAMP(3) NOT NULL,
  update_time   TIMESTAMP(3) NOT NULL
);

CREATE INDEX idx_app_runtime_queue_state ON app_runtime_queue (state, enqueued_at);
CREATE INDEX idx_app_runtime_queue_heartbeat ON app_runtime_queue (heartbeat_at);
