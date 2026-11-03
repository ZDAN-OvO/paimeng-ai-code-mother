-- #140：模型可以在 App runtime 内执行 shell 命令，每轮条数预算记在同一个 attempt 账本里。
-- 只追加重建 kind 的 CHECK，不改历史迁移；计数仍直接数 generation_attempt 行。

ALTER TABLE generation_attempt DROP CONSTRAINT IF EXISTS generation_attempt_kind_check;
ALTER TABLE generation_attempt ADD CONSTRAINT generation_attempt_kind_check
  CHECK (kind IN ('model', 'build', 'tool', 'shell'));
