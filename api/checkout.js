import { decryptText } from "../lib/crypto.js";
import { ensureQueueSchema, getSql } from "../lib/db.js";
import { requeueExpiredCheckoutHolds } from "../lib/queue-maintenance.js";

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await ensureQueueSchema();
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (token.length < 24) throw new Error("Checkout link is invalid.");

    const db = getSql();
    await requeueExpiredCheckoutHolds(db);
    const rows = await db`
      select checkout_url_cipher, checkout_url_iv, checkout_url_tag
      from queued_sessions
      where checkout_token = ${token}
        and checkout_token_expires_at > now()
        and status = 'action_required'
      limit 1
    `;

    if (!rows.length) {
      if (request.query.format === "json") {
        response.status(410).json({
          ok: false,
          expired: true,
          message: "Checkout link expired. The session has been queued again.",
        });
        return;
      }
      response.writeHead(302, { Location: "../?checkoutExpired=1" });
      response.end();
      return;
    }

    const checkoutUrl = decryptText({
      cipher: rows[0].checkout_url_cipher,
      iv: rows[0].checkout_url_iv,
      tag: rows[0].checkout_url_tag,
    });

    if (checkoutUrl.startsWith("checkout-post:")) {
      response
        .status(409)
        .send("This checkout link needs to be regenerated. Please go back to the app and queue/register again.");
      return;
    }

    if (request.query.format === "json") {
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        ok: true,
        checkoutUrl,
        checkoutType: "url",
      });
      return;
    }

    response.writeHead(302, { Location: checkoutUrl });
    response.end();
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
