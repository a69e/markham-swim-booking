import { ensureQueueSchema, getSql } from "./db.js";

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
      select count(*)::int as queued_count
      from queued_sessions
    `;

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      database: "connected",
      queuedCount: rows[0]?.queued_count ?? 0,
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
