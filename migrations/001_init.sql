-- 001 初始结构：真实本地项目、对话、逐文件改动、Agent 运行与审批。
-- schema_migration 由迁移器创建；这一版可以重写，之后只能追加迁移。

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template_id TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL,
  file_index TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE UNIQUE INDEX project_workspace_path_unique ON project (workspace_path);

CREATE TABLE chat (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  archived_at INTEGER
);
CREATE INDEX chat_project_updated_idx ON chat (project_id, updated_at);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  status TEXT,
  stop_reason TEXT,
  error TEXT,
  change_set_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  finished_at INTEGER
);
CREATE UNIQUE INDEX message_chat_seq_unique ON message (chat_id, seq);
CREATE INDEX message_chat_created_idx ON message (chat_id, created_at);

CREATE TABLE change_set (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
  message_id TEXT,
  run_id TEXT,
  seq INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'applied',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE UNIQUE INDEX change_set_project_seq_unique ON change_set (project_id, seq);
CREATE INDEX change_set_project_created_idx ON change_set (project_id, created_at);

CREATE TABLE change_file (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_set (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  change TEXT NOT NULL,
  source TEXT NOT NULL,
  attribution TEXT NOT NULL,
  undo_state TEXT NOT NULL DEFAULT 'applied',
  before_blob TEXT,
  after_blob TEXT,
  before_exists INTEGER NOT NULL DEFAULT 0,
  after_exists INTEGER NOT NULL DEFAULT 0,
  before_size INTEGER NOT NULL DEFAULT 0,
  after_size INTEGER NOT NULL DEFAULT 0,
  before_binary INTEGER NOT NULL DEFAULT 0,
  after_binary INTEGER NOT NULL DEFAULT 0,
  before_mode TEXT,
  after_mode TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  undone_at INTEGER
);
CREATE UNIQUE INDEX change_file_set_path_unique ON change_file (change_set_id, path);
CREATE INDEX change_file_path_idx ON change_file (path);

CREATE TABLE agent_run (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  error TEXT,
  instance_id TEXT NOT NULL,
  step_count INTEGER NOT NULL DEFAULT 0,
  pending_approval_id TEXT,
  change_set_id TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  finished_at INTEGER
);
CREATE INDEX agent_run_chat_status_idx ON agent_run (chat_id, status);
CREATE UNIQUE INDEX agent_run_chat_active_unique ON agent_run (chat_id)
  WHERE status IN ('running', 'awaiting_approval');

CREATE TABLE agent_step (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  messages TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE UNIQUE INDEX agent_step_run_step_unique ON agent_step (run_id, step_number);

CREATE TABLE tool_execution (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  output TEXT,
  error TEXT,
  approval_id TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  finished_at INTEGER
);
CREATE UNIQUE INDEX tool_execution_run_call_unique ON tool_execution (run_id, tool_call_id);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  decided_at INTEGER
);
CREATE INDEX approval_run_status_idx ON approval (run_id, status);
CREATE INDEX approval_chat_status_idx ON approval (chat_id, status);

CREATE TABLE bash_command (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  output_path TEXT,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT,
  before_tree TEXT,
  after_tree TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  finished_at INTEGER
);
CREATE INDEX bash_run_idx ON bash_command (run_id);

CREATE TABLE file_operation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  run_id TEXT,
  change_set_id TEXT,
  path TEXT NOT NULL,
  operation TEXT NOT NULL,
  source TEXT NOT NULL,
  attribution TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'committed',
  before_blob TEXT,
  after_blob TEXT,
  before_exists INTEGER,
  after_exists INTEGER,
  before_mode TEXT,
  after_mode TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX file_operation_project_path_idx ON file_operation (project_id, path, created_at);

CREATE TABLE snapshot (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  tree TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX snapshot_project_run_idx ON snapshot (project_id, run_id);

CREATE TABLE skill (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE UNIQUE INDEX skill_source_slug_unique ON skill (source, slug);
