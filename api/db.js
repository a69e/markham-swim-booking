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
    create table if not exists queued_sessions (
      id bigserial primary key,
      device_id text not null,
      session_key text not null,
      session jsonb not null,
      status text not null default 'queued',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (device_id, session_key)
    )
  `;
}
