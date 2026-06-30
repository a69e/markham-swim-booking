import { encryptText, encryptionConfigured } from "./crypto.js";
import { ensureQueueSchema, getSql } from "./db.js";

const BASE_URL = "https://cityofmarkham.perfectmind.com";
const BOOKING_URL =
  `${BASE_URL}/Clients/BookMe4BookingPages/Classes` +
  "?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4" +
  "&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False";
const LOGIN_PATH = "/Clients/MemberRegistration/MemberSignIn";
const LOGIN_URL =
  `${BASE_URL}${LOGIN_PATH}?returnUrl=${encodeURIComponent(BOOKING_URL)}`;

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

function extractToken(html) {
  const formMatch = html.match(
    /<form[^>]+id="logonform"[\s\S]*?<\/form>/i,
  );
  const formHtml = formMatch ? formMatch[0] : html;
  const tokenMatch = formHtml.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  );
  if (!tokenMatch) throw new Error("Could not find login verification token.");
  return tokenMatch[1];
}

function setCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function splitCookies(cookieValues) {
  return cookieValues.flatMap((value) =>
    value.split(/,(?=\s*[^;,]+=[^;,]+)/g).map((cookie) => cookie.trim()),
  );
}

function cookieHeader(cookieValues) {
  return splitCookies(cookieValues)
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function verifyPerfectMindLogin(email, password) {
  const loginResponse = await fetch(LOGIN_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!loginResponse.ok) {
    throw new Error("Could not open City of Markham login.");
  }

  const loginCookies = setCookieValues(loginResponse.headers);
  const html = await loginResponse.text();
  const token = extractToken(html);
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    returnUrl: BOOKING_URL,
    username: email,
    password,
    bsubmit: "Login",
  });

  const verifyResponse = await fetch(`${BASE_URL}/SocialSite/MemberRegistration/MemberSignIn`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(loginCookies),
      Origin: BASE_URL,
      Referer: LOGIN_URL,
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });

  const responseCookies = [
    ...loginCookies,
    ...setCookieValues(verifyResponse.headers),
  ];
  const location = verifyResponse.headers.get("location") || "";
  const redirectedAwayFromLogin =
    verifyResponse.status >= 300 &&
    verifyResponse.status < 400 &&
    location &&
    !location.includes("MemberSignIn");

  if (!redirectedAwayFromLogin) {
    throw new Error("City of Markham login failed.");
  }

  return {
    verifiedAt: new Date().toISOString(),
    location,
    cookie: cookieHeader(responseCookies),
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

      const loginSession = await verifyPerfectMindLogin(
        body.email.trim(),
        body.password,
      );
      const encryptedPassword = encryptText(body.password);
      const encryptedSession = encryptText(JSON.stringify(loginSession));
      const userAgent = request.headers["user-agent"] || "";

      await db`
        insert into account_credentials (
          device_id,
          email,
          password_cipher,
          password_iv,
          password_tag,
          user_agent,
          session
        )
        values (
          ${body.deviceId},
          ${body.email.trim()},
          ${encryptedPassword.cipher},
          ${encryptedPassword.iv},
          ${encryptedPassword.tag},
          ${userAgent},
          ${JSON.stringify({
            cipher: encryptedSession.cipher,
            iv: encryptedSession.iv,
            tag: encryptedSession.tag,
            verifiedAt: loginSession.verifiedAt,
          })}
        )
        on conflict (device_id)
        do update set
          email = excluded.email,
          password_cipher = excluded.password_cipher,
          password_iv = excluded.password_iv,
          password_tag = excluded.password_tag,
          user_agent = excluded.user_agent,
          session = excluded.session,
          updated_at = now()
      `;

      response.status(200).json({
        ok: true,
        hasAccount: true,
        email: body.email.trim(),
      });
      return;
    }

    if (request.method === "DELETE") {
      const body = await readJsonBody(request);
      validateDeviceId(body.deviceId);

      await db`
        delete from account_credentials
        where device_id = ${body.deviceId}
      `;

      response.status(200).json({ ok: true, hasAccount: false });
      return;
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const status = error.message.includes("DATABASE_URL") ? 503 : 400;
    response.status(status).json({ error: error.message });
  }
}
