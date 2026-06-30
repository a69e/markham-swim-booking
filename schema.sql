create table if not exists queued_sessions (
  id bigserial primary key,
  device_id text not null,
  session_key text not null,
  session jsonb not null,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, session_key)
);
