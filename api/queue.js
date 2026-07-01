import { accountScopeForDevice, ensureQueueSchema, getSql } from "../lib/db.js";

function sessionKey(session) {
  return [
    session?.service || "",
    session?.date || "",
    session?.timeRange || "",
    session?.location || "",
  ].join("|");
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

function validateStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "queued";
  if (["queued", "registered", "failed", "expired", "action_required"].includes(normalized)) {
    return normalized;
  }
  return "queued";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.length < 8) {
    throw new Error("A valid deviceId is required.");
  }
}

async function defaultAttendeeForDevice(db, deviceId) {
  const rows = await db`
    select
      account_credentials.id as account_id,
      account_attendees.id as attendee_id,
      account_attendees.member_id,
      account_attendees.full_name,
      account_attendees.has_free_pass
    from account_credentials
    left join account_attendees
      on account_attendees.id = account_credentials.default_attendee_id
    where account_credentials.device_id = ${deviceId}
    limit 1
  `;

  if (!rows.length) {
    throw new Error("Please login before using Queue or automatic Register.");
  }
  if (!rows[0].attendee_id) {
    throw new Error("Attendees were not loaded during login. Please login again.");
  }
  if (!rows[0].has_free_pass) {
    throw new Error(`${rows[0].full_name} does not have a free pass. Automatic registration is disabled for paid registrations.`);
  }

  return rows[0];
}

export default async function handler(request, response) {
  try {
    await ensureQueueSchema();
    const db = getSql();

    if (request.method === "GET") {
      const deviceId =
        typeof request.query.deviceId === "string" ? request.query.deviceId : "";
      validateDeviceId(deviceId);
      const scope = await accountScopeForDevice(db, deviceId);

      const rows = scope.accountIds.length
        ? await db`
            select
              queued_sessions.session_key,
              queued_sessions.session,
              queued_sessions.status,
              queued_sessions.start_at,
              queued_sessions.end_at,
              queued_sessions.registered_at,
              queued_sessions.last_attempt_at,
              queued_sessions.last_error,
              queued_sessions.action_required_at,
              queued_sessions.checkout_token,
              queued_sessions.checkout_token_expires_at,
              queued_sessions.notified_at,
              queued_sessions.notification_error,
              queued_sessions.created_at,
              queued_sessions.attendee_id,
              account_attendees.full_name as attendee_name,
              account_attendees.has_free_pass
            from queued_sessions
            left join account_attendees
              on account_attendees.id = queued_sessions.attendee_id
            where queued_sessions.account_id = any(${scope.accountIds})
            order by queued_sessions.created_at desc
          `
        : await db`
            select
              queued_sessions.session_key,
              queued_sessions.session,
              queued_sessions.status,
              queued_sessions.start_at,
              queued_sessions.end_at,
              queued_sessions.registered_at,
              queued_sessions.last_attempt_at,
              queued_sessions.last_error,
              queued_sessions.action_required_at,
              queued_sessions.checkout_token,
              queued_sessions.checkout_token_expires_at,
              queued_sessions.notified_at,
              queued_sessions.notification_error,
              queued_sessions.created_at,
              queued_sessions.attendee_id,
              account_attendees.full_name as attendee_name,
              account_attendees.has_free_pass
            from queued_sessions
            left join account_attendees
              on account_attendees.id = queued_sessions.attendee_id
            where queued_sessions.device_id = ${deviceId}
            order by queued_sessions.created_at desc
          `;

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        queued: rows.map((row) => ({
          ...row,
          checkout_url:
            row.status === "action_required" &&
            row.checkout_token &&
            (!row.checkout_token_expires_at ||
              new Date(row.checkout_token_expires_at) > new Date())
              ? `./api/checkout?token=${encodeURIComponent(row.checkout_token)}`
              : "",
        })),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);

      const key = sessionKey(body.session);
      if (!key.replaceAll("|", "")) {
        throw new Error("A valid session is required.");
      }
      const status = validateStatus(body.status);
      const { startAt, endAt } = parseSessionTimes(body.session);
      const attendee = await defaultAttendeeForDevice(db, body.deviceId);
      const scope = await accountScopeForDevice(db, body.deviceId);
      const existingRows = scope.accountIds.length
        ? await db`
            select queued_sessions.id
            from queued_sessions
            left join account_attendees
              on account_attendees.id = queued_sessions.attendee_id
            where queued_sessions.account_id = any(${scope.accountIds})
              and queued_sessions.session_key = ${key}
              and (
                account_attendees.member_id = ${attendee.member_id}
                or queued_sessions.attendee_id = ${attendee.attendee_id}
              )
            order by queued_sessions.updated_at desc
            limit 1
          `
        : [];

      if (existingRows.length) {
        await db`
          update queued_sessions
          set device_id = ${body.deviceId},
              account_id = ${attendee.account_id},
              attendee_id = ${attendee.attendee_id},
              session = ${JSON.stringify(body.session)},
              status = ${status},
              start_at = ${startAt},
              end_at = ${endAt},
              registered_at = case
                when ${status} = 'registered' then coalesce(registered_at, now())
                else registered_at
              end,
              auto_register = true,
              updated_at = now()
          where id = ${existingRows[0].id}
        `;
      } else {
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
            registered_at
          )
          values (
            ${body.deviceId},
            ${attendee.account_id},
            ${attendee.attendee_id},
            ${key},
            ${JSON.stringify(body.session)},
            ${status},
            ${startAt},
            ${endAt},
            ${status === "registered" ? new Date().toISOString() : null}
          )
          on conflict (device_id, attendee_id, session_key)
          do update set
            account_id = ${attendee.account_id},
            attendee_id = ${attendee.attendee_id},
            session = excluded.session,
            status = excluded.status,
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            registered_at = coalesce(queued_sessions.registered_at, excluded.registered_at),
            auto_register = true,
            updated_at = now()
        `;
      }

      response.status(200).json({
        ok: true,
        key,
        status,
        attendeeName: attendee.full_name,
      });
      return;
    }

    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const status = error.message.includes("DATABASE_URL") ? 503 : 400;
    response.status(status).json({ error: error.message });
  }
}
