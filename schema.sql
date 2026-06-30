create table if not exists account_credentials (
  id bigserial primary key,
  device_id text not null unique,
  email text not null,
  full_name text,
  password_cipher text not null,
  password_iv text not null,
  password_tag text not null,
  user_agent text,
  session jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists queued_sessions (
  id bigserial primary key,
  device_id text not null,
  account_id bigint references account_credentials(id) on delete set null,
  session_key text not null,
  session jsonb not null,
  status text not null default 'queued',
  start_at timestamptz,
  end_at timestamptz,
  registered_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, session_key)
);
