import { ensureQueueSchema, getSql } from "../lib/db.js";
import { fetchLiveClassPages } from "../lib/live-classes.js";
import { requeueExpiredCheckoutHolds } from "../lib/queue-maintenance.js";
import { inferSessionTimes } from "../lib/session-times.js";
import { attemptQueuedRegistration } from "./register.js";

function runSource(request) {
  const headerSource = request.headers["x-cron-source"];
  if (typeof headerSource === "string" && headerSource.trim()) {
    return headerSource.trim().slice(0, 60);
  }
  const querySource = request.query?.source;
  if (typeof querySource === "string" && querySource.trim()) {
    return querySource.trim().slice(0, 60);
  }
  return "external";
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
      and coalesce(queued_sessions.session->>'action', '') ilike '%register%'
      and (
        queued_sessions.last_attempt_at is null
        or queued_sessions.last_attempt_at < now() - interval '55 seconds'
      )
    order by queued_sessions.start_at nulls last, queued_sessions.created_at
    limit 3
  `;
}

function sessionKey(session) {
  return [
    session?.service || "",
    session?.date || "",
    session?.timeRange || "",
    session?.location || "",
  ].join("|");
}

function liveKey(session) {
  return `${session?.eventId || ""}|${session?.occurrenceDate || ""}`;
}

function parsePerfectMindDate(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseSessionTimes(session) {
  const inferred = inferSessionTimes(session);
  if (inferred.startAt || inferred.endAt) return inferred;
  const start = parsePerfectMindDate(session?.startDateTime);
  const end = parsePerfectMindDate(session?.endDateTime);
  return { startAt: start ? start.toISOString() : null, endAt: end ? end.toISOString() : null };
}

async function syncQueuedRowsWithLiveClasses(db) {
  const rows = await db`
    select *
    from queued_sessions
    where status in ('queued', 'action_required')
  `;
  if (!rows.length) return { updated: 0, deleted: 0 };

  const liveSessions = await fetchLiveClassPages(6);
  const byLiveKey = new Map(liveSessions.map((session) => [liveKey(session), session]));
  const bySessionKey = new Map(liveSessions.map((session) => [sessionKey(session), session]));
  let updated = 0;
  let deleted = 0;

  for (const row of rows) {
    const rowLiveKey = liveKey(row.session);
    const current =
      (rowLiveKey !== "|" ? byLiveKey.get(rowLiveKey) : null) ||
      bySessionKey.get(row.session_key);
    const nextSession = current || row.session || {};
    const { startAt, endAt } = parseSessionTimes(nextSession);
    const endedAt = endAt || row.end_at;
    const ended = endedAt && new Date(endedAt) < new Date();

    if (ended) {
      await db`
        delete from queued_sessions
        where id = ${row.id}
          and status in ('queued', 'action_required')
      `;
      deleted += 1;
      continue;
    }

    if (current) {
      await db`
        update queued_sessions
        set session = ${JSON.stringify(nextSession)},
            start_at = coalesce(${startAt}, start_at),
            end_at = coalesce(${endAt}, end_at),
            updated_at = now()
        where id = ${row.id}
      `;
      updated += 1;
    }
  }

  return { updated, deleted };
}

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await ensureQueueSchema();
    const db = getSql();
    const requeuedExpiredCheckout = await requeueExpiredCheckoutHolds(db);
    const liveSync = await syncQueuedRowsWithLiveClasses(db);
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

    const registeredCount = results.filter((result) => result.registered).length;
    const actionRequiredCount = results.filter((result) => result.actionRequired).length;
    const errorCount = results.filter((result) => !result.ok).length;
    await db`
      insert into queue_worker_runs (
        source,
        ok,
        checked_count,
        registered_count,
        action_required_count,
        error_count,
        message
      )
      values (
        ${runSource(request)},
        ${errorCount === 0},
        ${rows.length},
        ${registeredCount},
        ${actionRequiredCount},
        ${errorCount},
        ${JSON.stringify({ requeuedExpiredCheckout, liveSync, results: results.slice(0, 8) })}
      )
    `;

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      requeuedExpiredCheckout,
      liveSync,
      checked: rows.length,
      registeredCount,
      actionRequiredCount,
      errorCount,
      results,
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
