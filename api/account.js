import { encryptText, encryptionConfigured } from "./crypto.js";
import { ensureQueueSchema, getSql } from "./db.js";

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

function validateEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("A valid email is required.");
  }
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 1) {
    throw new Error("A password is required.");
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
        select email, updated_at
        from account_credentials
        where device_id = ${deviceId}
        limit 1
      `;

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        hasAccount: rows.length > 0,
        email: rows[0]?.email || "",
        updatedAt: rows[0]?.updated_at || null,
        encryptionConfigured: encryptionConfigured(),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);
      validateEmail(body.email);
      validatePassword(body.password);

      const encryptedPassword = encryptText(body.password);
      const userAgent = request.headers["user-agent"] || "";

      await db`
        insert into account_credentials (
          device_id,
          email,
          password_cipher,
          password_iv,
          password_tag,
          user_agent
        )
        values (
          ${body.deviceId},
          ${body.email.trim()},
          ${encryptedPassword.cipher},
          ${encryptedPassword.iv},
          ${encryptedPassword.tag},
          ${userAgent}
        )
        on conflict (device_id)
        do update set
          email = excluded.email,
          password_cipher = excluded.password_cipher,
          password_iv = excluded.password_iv,
          password_tag = excluded.password_tag,
          user_agent = excluded.user_agent,
          updated_at = now()
      `;

      response.status(200).json({
        ok: true,
        hasAccount: true,
        email: body.email.trim(),
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
