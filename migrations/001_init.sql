create table project (
  id text primary key not null,
  name text not null,
  description text not null default '',
  template_id text not null default 'auto',
  workspace_path text not null unique,
  env text not null default '[]',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table chat (
  id text primary key not null,
  project_id text not null references project(id) on delete cascade,
  title text not null,
  model_id text not null,
  archived_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table message (
  id text primary key not null,
  chat_id text not null references chat(id) on delete cascade,
  seq integer not null,
  role text not null,
  parts text not null,
  status text,
  completion_reviewed integer,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at text
);
create unique index message_chat_seq on message(chat_id, seq);

create table change_set (
  id text primary key not null,
  project_id text not null references project(id) on delete cascade,
  chat_id text not null references chat(id) on delete cascade,
  message_id text references message(id) on delete set null,
  seq integer not null,
  summary text not null,
  status text not null default 'applied',
  changed_files text not null,
  before_files text not null,
  after_files text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index change_set_project_seq on change_set(project_id, seq);

create table skill (
  id text primary key not null,
  slug text not null,
  description text not null,
  source text not null,
  trusted integer not null default 0,
  enabled integer not null default 1,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index skill_source_slug on skill(source, slug);
