import { ensureQueueSchema, getSql } from "./db.js";
import { attemptQueuedRegistration } from "./register.js";

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return true;

  const token =
    request.headers["x-cron-secret"] ||
    request.query?.token ||
    "";
  return token === secret;
}

async function activeQueuedRows(db) {
  return db`
    select queued_sessions.*
    from queued_sessions
    join account_attendees
      on account_attendees.id = queued_sessions.attendee_id
    where queued_sessions.status = 'queued'
      and queued_sessions.auto_register = true
      and account_attendees.has_free_pass = true
      and (queued_sessions.end_at is null or queued_sessions.end_at > now())
      and (
        queued_sessions.last_attempt_at is null
        or queued_sessions.last_attempt_at < now() - interval '55 seconds'
      )
    order by queued_sessions.start_at nulls last, queued_sessions.created_at
    limit 3
  `;
}

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    if (!cronAuthorized(request)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    await ensureQueueSchema();
    const db = getSql();
    const rows = await activeQueuedRows(db);
    const results = [];

    for (const row of rows) {
      try {
        const result = await attemptQueuedRegistration(db, row, { dryRun: false });
        results.push({
          id: row.id,
          key: row.session_key,
          ok: true,
          registered: result.registrationConfirmed,
          actionRequired: result.actionRequired,
          checkoutUrl: result.checkoutUrl || "",
          message: result.message,
          attendee: result.attendee?.fullName || "",
        });
      } catch (error) {
        await db`
          update queued_sessions
          set last_attempt_at = now(),
              last_error = ${error.message},
              updated_at = now()
          where id = ${row.id}
        `;
        results.push({
          id: row.id,
          key: row.session_key,
          ok: false,
          registered: false,
          error: error.message,
        });
      }
    }

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      checked: rows.length,
      results,
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
