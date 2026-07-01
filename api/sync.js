import { accountScopeForDevice, ensureQueueSchema, getSql } from "../lib/db.js";
import { fetchLiveClassPages } from "../lib/live-classes.js";

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.length < 8) {
    throw new Error("A valid deviceId is required.");
  }
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
  const start = parsePerfectMindDate(session?.startDateTime);
  const end = parsePerfectMindDate(session?.endDateTime);
  return {
    startAt: start ? start.toISOString() : null,
    endAt: end ? end.toISOString() : null,
  };
}

async function rowsForScope(db, deviceId, accountIds) {
  return accountIds.length
    ? db`
        select *
        from queued_sessions
        where account_id = any(${accountIds})
      `
    : db`
        select *
        from queued_sessions
        where device_id = ${deviceId}
      `;
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
    const deviceId =
      typeof request.query.deviceId === "string" ? request.query.deviceId : "";
    validateDeviceId(deviceId);

    const scope = await accountScopeForDevice(db, deviceId);
    const trackedRows = await rowsForScope(db, deviceId, scope.accountIds);
    const liveSessions = await fetchLiveClassPages(6);
    const byLiveKey = new Map(liveSessions.map((session) => [liveKey(session), session]));
    const bySessionKey = new Map(
      liveSessions.map((session) => [sessionKey(session), session]),
    );

    let updated = 0;
    let expired = 0;
    let checkoutExpired = 0;
    const now = new Date();

    for (const row of trackedRows) {
      const rowLiveKey = liveKey(row.session);
      const current =
        (rowLiveKey !== "|" ? byLiveKey.get(rowLiveKey) : null) ||
        bySessionKey.get(row.session_key);
      const nextSession = current || row.session || {};
      const { startAt, endAt } = parseSessionTimes(nextSession);
      const ended =
        (endAt && new Date(endAt) < now) ||
        (row.end_at && new Date(row.end_at) < now);
      const holdExpired =
        row.status === "action_required" &&
        row.checkout_token_expires_at &&
        new Date(row.checkout_token_expires_at) < now;

      if (ended) {
        await db`
          update queued_sessions
          set status = case when status = 'registered' then status else 'expired' end,
              session = ${JSON.stringify(nextSession)},
              start_at = coalesce(${startAt}, start_at),
              end_at = coalesce(${endAt}, end_at),
              last_attempt_at = now(),
              last_error = case
                when status = 'registered' then last_error
                else 'Session has ended.'
              end,
              updated_at = now()
          where id = ${row.id}
        `;
        expired += 1;
        continue;
      }

      if (holdExpired) {
        await db`
          update queued_sessions
          set status = 'queued',
              session = ${JSON.stringify(nextSession)},
              start_at = coalesce(${startAt}, start_at),
              end_at = coalesce(${endAt}, end_at),
              checkout_token = null,
              checkout_token_expires_at = null,
              checkout_url_cipher = null,
              checkout_url_iv = null,
              checkout_url_tag = null,
              last_attempt_at = now(),
              last_error = 'Checkout hold expired; queued again.',
              updated_at = now()
          where id = ${row.id}
        `;
        checkoutExpired += 1;
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

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      accountSynced: Boolean(scope.account),
      liveCount: liveSessions.length,
      trackedCount: trackedRows.length,
      updated,
      expired,
      checkoutExpired,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
