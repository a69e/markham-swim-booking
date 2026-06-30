import { ensureQueueSchema, getSql } from "./db.js";

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
  if (["queued", "registered", "failed", "expired"].includes(normalized)) {
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

export default async function handler(request, response) {
  try {
    await ensureQueueSchema();
    const db = getSql();

    if (request.method === "GET") {
      const deviceId =
        typeof request.query.deviceId === "string" ? request.query.deviceId : "";
      validateDeviceId(deviceId);

      const rows = await db`
        select session_key, session, status, start_at, end_at, registered_at, created_at
        from queued_sessions
        where device_id = ${deviceId}
        order by created_at desc
      `;

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ queued: rows });
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

      await db`
        insert into queued_sessions (
          device_id,
          account_id,
          session_key,
          session,
          status,
          start_at,
          end_at,
          registered_at
        )
        values (
          ${body.deviceId},
          (select id from account_credentials where device_id = ${body.deviceId}),
          ${key},
          ${JSON.stringify(body.session)},
          ${status},
          ${startAt},
          ${endAt},
          ${status === "registered" ? new Date().toISOString() : null}
        )
        on conflict (device_id, session_key)
        do update set
          account_id = (select id from account_credentials where device_id = ${body.deviceId}),
          session = excluded.session,
          status = excluded.status,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          registered_at = coalesce(queued_sessions.registered_at, excluded.registered_at),
          updated_at = now()
      `;

      response.status(200).json({ ok: true, key, status });
      return;
    }

    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const status = error.message.includes("DATABASE_URL") ? 503 : 400;
    response.status(status).json({ error: error.message });
  }
}
