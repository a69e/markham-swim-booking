import { decryptText } from "../lib/crypto.js";
import { ensureQueueSchema, getSql } from "../lib/db.js";

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeCheckoutTarget(value) {
  if (!String(value || "").startsWith("checkout-post:")) {
    return { type: "url", url: value };
  }

  const payload = JSON.parse(String(value).slice("checkout-post:".length));
  if (!payload.action || !Array.isArray(payload.fields)) {
    throw new Error("Checkout form is invalid.");
  }
  return { type: "post", action: payload.action, fields: payload.fields };
}

function checkoutPostHtml(target) {
  const fields = target.fields
    .map(([name, value]) =>
      `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening checkout</title>
  </head>
  <body>
    <form id="checkoutForm" method="post" action="${htmlEscape(target.action)}">
      ${fields}
      <noscript>
        <button type="submit">Continue to checkout</button>
      </noscript>
    </form>
    <script>document.getElementById("checkoutForm").submit();</script>
  </body>
</html>`;
}

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
    const rows = await db`
      select checkout_url_cipher, checkout_url_iv, checkout_url_tag
      from queued_sessions
      where checkout_token = ${token}
        and checkout_token_expires_at > now()
        and status = 'action_required'
      limit 1
    `;

    if (!rows.length) {
      response.status(404).send("Checkout link expired or not found.");
      return;
    }

    const decrypted = decryptText({
      cipher: rows[0].checkout_url_cipher,
      iv: rows[0].checkout_url_iv,
      tag: rows[0].checkout_url_tag,
    });
    const target = decodeCheckoutTarget(decrypted);

    if (request.query.format === "json") {
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        ok: true,
        checkoutUrl: target.type === "url" ? target.url : "",
        checkoutType: target.type,
      });
      return;
    }

    if (target.type === "post") {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.status(200).send(checkoutPostHtml(target));
      return;
    }

    response.writeHead(302, { Location: target.url });
    response.end();
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
