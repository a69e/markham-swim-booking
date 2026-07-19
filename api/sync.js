import { accountScopeForDevice, ensureQueueSchema, getSql } from "../lib/db.js";
import { decryptText } from "../lib/crypto.js";
import { syncAttendeesFromOfficialSite } from "../lib/attendee-sync.js";
import { fetchLiveClassPages } from "../lib/live-classes.js";
import { requeueExpiredCheckoutHolds } from "../lib/queue-maintenance.js";
import { inferSessionTimes } from "../lib/session-times.js";
import {
  fetchOfficialScheduleEvents,
  normalizeScheduleEvent,
} from "../lib/official-schedule.js";
import { verifyPerfectMindLogin } from "./account.js";

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
  const inferred = inferSessionTimes(session);
  if (inferred.startAt || inferred.endAt) return inferred;
  const start = parsePerfectMindDate(session?.startDateTime);
  const end = parsePerfectMindDate(session?.endDateTime);
  return { startAt: start ? start.toISOString() : null, endAt: end ? end.toISOString() : null };
}

function officialScheduleKey(contactId, eventId, occurrenceDate) {
  return `${contactId || ""}|${eventId || ""}|${occurrenceDate || ""}`;
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
    let checkoutExpired = await requeueExpiredCheckoutHolds(db);
    const trackedRows = await rowsForScope(db, deviceId, scope.accountIds);
    const liveSessions = await fetchLiveClassPages(1);
    const byLiveKey = new Map(liveSessions.map((session) => [liveKey(session), session]));
    const bySessionKey = new Map(
      liveSessions.map((session) => [sessionKey(session), session]),
    );

    let updated = 0;
    let deleted = 0;
    let officialUnregistered = 0;
    let officialImported = 0;
    let officialScheduleSynced = false;
    let officialScheduleError = "";
    let attendeePassSynced = false;
    let attendeePassSyncError = "";
    let attendeePassSync = null;
    const now = new Date();
    if (scope.account) {
      try {
        const password = decryptText({
          cipher: scope.account.password_cipher,
          iv: scope.account.password_iv,
          tag: scope.account.password_tag,
        });
        const login = await verifyPerfectMindLogin(scope.account.email, password);
        attendeePassSync = await syncAttendeesFromOfficialSite(
          db,
          scope.account.id,
          login.cookie,
          {
            email: scope.account.email,
            password,
          },
        );
        attendeePassSynced = Boolean(attendeePassSync?.ok);
        if (!attendeePassSynced) {
          attendeePassSyncError = attendeePassSync?.error || "Attendee pass sync failed.";
        }
      } catch (error) {
        attendeePassSyncError = error.message;
      }
    }
    const attendeeRows = scope.accountIds.length
      ? await db`
          select distinct on (member_id)
            id,
            member_id,
            full_name
          from account_attendees
          where account_id = any(${scope.accountIds})
          order by member_id, updated_at desc
        `
      : [];
    const attendeeById = new Map(attendeeRows.map((attendee) => [String(attendee.id), attendee]));
    const attendeeByMemberId = new Map(
      attendeeRows.map((attendee) => [attendee.member_id, attendee]),
    );
    let officialScheduleEvents = [];
    if (scope.account && attendeeRows.length) {
      try {
        officialScheduleEvents = await fetchOfficialScheduleEvents(scope.account, attendeeRows);
        officialScheduleSynced = true;
      } catch (error) {
        officialScheduleError = error.message;
      }
    }
    const officialScheduleSessions = officialScheduleEvents.map((event) => ({
      event,
      normalized: normalizeScheduleEvent(event),
    }));
    const officialScheduleKeys = new Set(
      officialScheduleSessions.map(({ normalized }) =>
        officialScheduleKey(
          normalized.contactId,
          normalized.eventId,
          normalized.occurrenceDate,
        ),
      ),
    );

    function rowOfficialKey(row) {
      const attendee = attendeeById.get(String(row.attendee_id || ""));
      return officialScheduleKey(
        row.session?.contactId || attendee?.member_id || "",
        row.session?.eventId || "",
        row.session?.occurrenceDate || "",
      );
    }

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
      if (ended) {
        await db`
          delete from queued_sessions
          where id = ${row.id}
            and status in ('queued', 'action_required')
        `;
        if (row.status === "queued" || row.status === "action_required") {
          deleted += 1;
          continue;
        }
        await db`
          update queued_sessions
          set session = ${JSON.stringify(nextSession)},
              start_at = coalesce(${startAt}, start_at),
              end_at = coalesce(${endAt}, end_at),
              updated_at = now()
          where id = ${row.id}
        `;
        continue;
      }

      if (officialScheduleSynced && row.status === "action_required") {
        if (officialScheduleKeys.has(rowOfficialKey({ ...row, session: nextSession }))) {
          await db`
            update queued_sessions
            set status = 'registered',
                session = ${JSON.stringify(nextSession)},
                start_at = coalesce(${startAt}, start_at),
                end_at = coalesce(${endAt}, end_at),
                registered_at = coalesce(registered_at, now()),
                checkout_token = null,
                checkout_token_expires_at = null,
                checkout_url_cipher = null,
                checkout_url_iv = null,
                checkout_url_tag = null,
                last_attempt_at = now(),
                last_error = '',
                updated_at = now()
            where id = ${row.id}
          `;
          officialImported += 1;
          continue;
        }
      }

      if (officialScheduleSynced && row.status === "registered") {
        if (!officialScheduleKeys.has(rowOfficialKey({ ...row, session: nextSession }))) {
          await db`
            delete from queued_sessions
            where id = ${row.id}
              and status = 'registered'
          `;
          officialUnregistered += 1;
          continue;
        }
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

    if (officialScheduleSynced) {
      for (const { event, normalized } of officialScheduleSessions) {
        const attendee = attendeeByMemberId.get(normalized.contactId || event.ContactId || "");
        if (!attendee) continue;
        const liveSession = byLiveKey.get(liveKey(normalized));
        const session = {
          ...(liveSession || normalized),
          attendanceId: normalized.attendanceId,
          contactId: normalized.contactId,
        };
        const key = sessionKey(session);
        const { startAt, endAt } = parseSessionTimes(session);
        const existingRows = await db`
          select id
          from queued_sessions
          where account_id = any(${scope.accountIds})
            and attendee_id = ${attendee.id}
            and session->>'eventId' = ${session.eventId}
            and session->>'occurrenceDate' = ${session.occurrenceDate}
          order by updated_at desc
          limit 1
        `;
        if (existingRows.length) {
          await db`
            update queued_sessions
            set device_id = ${deviceId},
                account_id = ${scope.account.id},
                attendee_id = ${attendee.id},
                session_key = ${key},
                session = ${JSON.stringify(session)},
                status = 'registered',
                start_at = ${startAt},
                end_at = ${endAt},
                registered_at = coalesce(registered_at, now()),
                last_attempt_at = now(),
                last_error = '',
                updated_at = now()
            where id = ${existingRows[0].id}
          `;
          continue;
        }
        await db`
          insert into queued_sessions (
            device_id,
            account_id,
            attendee_id,
            session_key,
            session,
            status,
            start_at,
            end_at,
            registered_at,
            last_attempt_at,
            last_error
          )
          values (
            ${deviceId},
            ${scope.account.id},
            ${attendee.id},
            ${key},
            ${JSON.stringify(session)},
            'registered',
            ${startAt},
            ${endAt},
            now(),
            now(),
            ''
          )
          on conflict (device_id, attendee_id, session_key)
          do update set
            account_id = excluded.account_id,
            attendee_id = excluded.attendee_id,
            session = excluded.session,
            status = 'registered',
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            registered_at = coalesce(queued_sessions.registered_at, now()),
            last_attempt_at = now(),
            last_error = '',
            updated_at = now()
        `;
        officialImported += 1;
      }
    }

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      accountSynced: Boolean(scope.account),
      liveCount: liveSessions.length,
      trackedCount: trackedRows.length,
      updated,
      deleted,
      checkoutExpired,
      officialUnregistered,
      officialImported,
      officialScheduleSynced,
      officialScheduleError,
      attendeePassSynced,
      attendeePassSyncError,
      attendeePassSync,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
