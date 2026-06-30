import { neon } from "@neondatabase/serverless";

let sql;

export function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

export async function ensureQueueSchema() {
  const db = getSql();
  await db`
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
    )
  `;

  await db`
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
    )
  `;

  await db`
    alter table queued_sessions
    add column if not exists account_id bigint references account_credentials(id) on delete set null
  `;

  await db`
    alter table queued_sessions
    add column if not exists start_at timestamptz,
    add column if not exists end_at timestamptz,
    add column if not exists registered_at timestamptz,
    add column if not exists last_attempt_at timestamptz,
    add column if not exists last_error text
  `;

  await db`
    alter table account_credentials
    add column if not exists full_name text
  `;

  await db`
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
    )
  `;

  await db`
    alter table account_credentials
    add column if not exists default_attendee_id bigint references account_attendees(id) on delete set null
  `;
}
