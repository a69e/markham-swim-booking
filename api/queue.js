import { ensureQueueSchema, getSql } from "./db.js";

function sessionKey(session) {
  return [
    session?.service || "",
    session?.date || "",
    session?.timeRange || "",
    session?.location || "",
  ].join("|");
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
        select session_key, session, status, created_at
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

      await db`
        insert into queued_sessions (device_id, session_key, session, status)
        values (${body.deviceId}, ${key}, ${JSON.stringify(body.session)}, 'queued')
        on conflict (device_id, session_key)
        do update set
          session = excluded.session,
          status = 'queued',
          updated_at = now()
      `;

      response.status(200).json({ ok: true, key });
      return;
    }

    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const status = error.message.includes("DATABASE_URL") ? 503 : 400;
    response.status(status).json({ error: error.message });
  }
}
