import { ensureQueueSchema, getSql } from "./db.js";

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.length < 8) {
    throw new Error("A valid deviceId is required.");
  }
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

function attendeePayload(row) {
  return {
    id: row.id,
    name: row.full_name,
    isOwner: row.is_owner,
    isDefault: row.is_default || row.id === row.default_attendee_id,
    hasFreePass: row.has_free_pass,
    priceName: row.price_name || "",
    priceDisplay: row.price_display || "",
  };
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
        select
          account_attendees.id,
          account_attendees.full_name,
          account_attendees.is_owner,
          account_attendees.is_default,
          account_attendees.has_free_pass,
          account_attendees.price_name,
          account_attendees.price_display,
          account_credentials.default_attendee_id
        from account_credentials
        join account_attendees
          on account_attendees.account_id = account_credentials.id
        where account_credentials.device_id = ${deviceId}
        order by
          account_attendees.is_default desc,
          account_attendees.is_owner desc,
          account_attendees.full_name
      `;

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ attendees: rows.map(attendeePayload) });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);
      const attendeeId = Number(body.attendeeId);
      if (!Number.isInteger(attendeeId) || attendeeId <= 0) {
        throw new Error("A valid attendeeId is required.");
      }

      const rows = await db`
        select account_credentials.id as account_id, account_attendees.full_name
        from account_credentials
        join account_attendees
          on account_attendees.account_id = account_credentials.id
        where account_credentials.device_id = ${body.deviceId}
          and account_attendees.id = ${attendeeId}
        limit 1
      `;
      if (!rows.length) throw new Error("Attendee was not found for this device.");

      await db`
        update account_attendees
        set is_default = id = ${attendeeId},
            updated_at = now()
        where account_id = ${rows[0].account_id}
      `;
      await db`
        update account_credentials
        set default_attendee_id = ${attendeeId},
            full_name = ${rows[0].full_name},
            updated_at = now()
        where id = ${rows[0].account_id}
      `;

      response.status(200).json({
        ok: true,
        attendeeId,
        displayName: rows[0].full_name,
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
