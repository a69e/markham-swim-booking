import { ensureQueueSchema, getSql } from "./db.js";
import { publicVapidKey, pushConfigured } from "./notifications.js";

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

function validSubscription(subscription) {
  return (
    subscription &&
    typeof subscription.endpoint === "string" &&
    subscription.endpoint.startsWith("https://") &&
    subscription.keys &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  );
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
        select id
        from push_subscriptions
        where device_id = ${deviceId}
        limit 1
      `;

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        ok: true,
        configured: pushConfigured(),
        publicKey: publicVapidKey(),
        subscribed: rows.length > 0,
      });
      return;
    }

    if (request.method === "POST") {
      if (!pushConfigured()) {
        response.status(503).json({ error: "Web Push is not configured yet." });
        return;
      }

      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);
      if (!validSubscription(body.subscription)) {
        throw new Error("A valid push subscription is required.");
      }

      const accountRows = await db`
        select id
        from account_credentials
        where device_id = ${body.deviceId}
        limit 1
      `;
      const accountId = accountRows[0]?.id || null;

      await db`
        insert into push_subscriptions (
          device_id,
          account_id,
          endpoint,
          subscription,
          user_agent
        )
        values (
          ${body.deviceId},
          ${accountId},
          ${body.subscription.endpoint},
          ${JSON.stringify(body.subscription)},
          ${request.headers["user-agent"] || ""}
        )
        on conflict (endpoint)
        do update set
          device_id = excluded.device_id,
          account_id = excluded.account_id,
          subscription = excluded.subscription,
          user_agent = excluded.user_agent,
          last_error = null,
          updated_at = now()
      `;

      response.status(200).json({ ok: true, subscribed: true });
      return;
    }

    if (request.method === "DELETE") {
      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);
      await db`
        delete from push_subscriptions
        where device_id = ${body.deviceId}
      `;
      response.status(200).json({ ok: true, subscribed: false });
      return;
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
