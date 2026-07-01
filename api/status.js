import { ensureQueueSchema, getSql } from "../lib/db.js";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await ensureQueueSchema();
    const db = getSql();
    const rows = await db`
      select
        count(*)::int as total_count,
        count(*) filter (where status = 'queued')::int as queued_count,
        count(*) filter (where status = 'registered')::int as registered_count
      from queued_sessions
    `;
    const accountRows = await db`
      select count(*)::int as account_count
      from account_credentials
    `;

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      database: "connected",
      totalSessionCount: rows[0]?.total_count ?? 0,
      queuedCount: rows[0]?.queued_count ?? 0,
      registeredCount: rows[0]?.registered_count ?? 0,
      accountCount: accountRows[0]?.account_count ?? 0,
      encryptionConfigured: Boolean(
        process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 32,
      ),
    });
  } catch (error) {
    const status = error.message.includes("DATABASE_URL") ? 503 : 500;
    response.status(status).json({
      ok: false,
      database: "unavailable",
      error: error.message,
    });
  }
}
