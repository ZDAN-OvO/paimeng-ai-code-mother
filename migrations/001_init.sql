create table project (
  id text primary key,
  user_id text not null,
  name text not null,
  env jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table chat (
  id text primary key,
  project_id text not null references project (id) on delete cascade,
  title text not null,
  model_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table message (
  id text primary key,
  chat_id text not null references chat (id) on delete cascade,
  seq integer not null,
  role text not null,
  parts jsonb not null,
  created_at timestamptz not null default now()
);
create unique index message_chat_seq on message (chat_id, seq);

create table version (
  id text primary key,
  chat_id text not null references chat (id) on delete cascade,
  message_id text not null,
  seq integer not null,
  snapshot_path text not null,
  created_at timestamptz not null default now()
);
create unique index version_chat_seq on version (chat_id, seq);

create table skill (
  id text primary key,
  owner_id text,
  slug text not null,
  description text not null,
  source text not null,
  trusted boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index skill_owner_slug on skill (owner_id, slug);

create table deploy (
  id text primary key,
  project_id text not null references project (id) on delete cascade,
  version_id text not null,
  deploy_key text not null unique,
  state text not null,
  artifact_path text,
  created_at timestamptz not null default now()
);

create table sandbox_session (
  id text primary key,
  chat_id text not null unique references chat (id) on delete cascade,
  container_id text not null,
  volume text not null,
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null
);
