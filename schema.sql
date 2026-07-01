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
  attendee_id bigint,
  session_key text not null,
  session jsonb not null,
  status text not null default 'queued',
  start_at timestamptz,
  end_at timestamptz,
  registered_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  action_required_at timestamptz,
  checkout_token text,
  checkout_token_expires_at timestamptz,
  checkout_url_cipher text,
  checkout_url_iv text,
  checkout_url_tag text,
  notified_at timestamptz,
  notification_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists account_attendees (
  id bigserial primary key,
  account_id bigint not null references account_credentials(id) on delete cascade,
  member_id text not null,
  account_member_id text,
  full_name text not null,
  family_membership text,
  price_type_id text,
  price_name text,
  price_display text,
  price_amount numeric,
  is_owner boolean not null default false,
  has_free_pass boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, member_id)
);

create table if not exists push_subscriptions (
  id bigserial primary key,
  device_id text not null,
  account_id bigint references account_credentials(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error text
);

create unique index if not exists queued_sessions_device_attendee_session_key_idx
on queued_sessions (device_id, attendee_id, session_key);
