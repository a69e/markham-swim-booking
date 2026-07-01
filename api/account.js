import { encryptText, encryptionConfigured } from "./crypto.js";
import { ensureQueueSchema, getSql } from "./db.js";
import { syncAttendeesFromOfficialSite } from "./attendee-sync.js";

const BASE_URL = "https://cityofmarkham.perfectmind.com";
const BOOKING_URL =
  `${BASE_URL}/Clients/BookMe4BookingPages/Classes` +
  "?calendarId=39bd5c76-e07f-43f3-af24-c6969091dbb4" +
  "&widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&embed=False";
const LOGIN_PATH = "/Clients/MemberRegistration/MemberSignIn";
const CONTACT_URL = `${BASE_URL}/Clients/Contact`;

function loginPathForReturnUrl(returnUrl) {
  return String(returnUrl || "").includes("/SocialSite/")
    ? "/SocialSite/MemberRegistration/MemberSignIn"
    : LOGIN_PATH;
}

function loginUrl(returnUrl = BOOKING_URL) {
  return `${BASE_URL}${loginPathForReturnUrl(returnUrl)}?returnUrl=${encodeURIComponent(returnUrl)}`;
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

function mergeCookieHeader(existingCookie, response) {
  const rawCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie().join(",")
      : response.headers.get("set-cookie") || "";
  const cookiePairs = new Map();

  String(existingCookie || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const name = pair.split("=")[0];
      cookiePairs.set(name, pair);
    });

  String(rawCookie || "")
    .split(/,(?=\s*[^;,]+=[^;,]+)/g)
    .map((cookie) => cookie.trim().split(";")[0])
    .filter(Boolean)
    .forEach((pair) => {
      const name = pair.split("=")[0];
      if (pair.endsWith("=")) {
        cookiePairs.delete(name);
      } else {
        cookiePairs.set(name, pair);
      }
    });

  return [...cookiePairs.values()].join("; ");
}

async function followLoginRedirects(initialLocation, initialCookie) {
  let url = new URL(initialLocation, BASE_URL).toString();
  let cookie = initialCookie;
  const redirects = [url];
  let finalUrl = url;

  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });
    cookie = mergeCookieHeader(cookie, response);
    finalUrl = url;

    const location = response.headers.get("location") || "";
    if (response.status < 300 || response.status >= 400 || !location) break;

    url = new URL(location, url).toString();
    redirects.push(url);
  }

  return { cookie, redirects, finalUrl };
}

function htmlDecode(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return htmlDecode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value) {
  const cleaned = stripTags(value)
    .replace(/^(welcome|hello|hi),?\s+/i, "")
    .replace(/\s+(my account|my info|logout|login)$/i, "")
    .trim();

  if (
    !cleaned ||
    cleaned.includes("@") ||
    cleaned.length > 80 ||
    /^(my account|my info|logout|login|swimming|contact|profile)$/i.test(cleaned)
  ) {
    return "";
  }
  return cleaned;
}

function extractFullName(html) {
  const patterns = [
    /id=["'](?:Contact_FullName|FullName|fullName)["'][^>]*value=["']([^"']+)["']/i,
    /name=["'](?:FullName|fullName)["'][^>]*value=["']([^"']+)["']/i,
    /id=["']OptionsSelector["'][\s\S]*?<li[^>]*class=["'][^"']*global_menu[^"']*["'][\s\S]*?<span[^>]*class=["'][^"']*k-link[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /class=["'][^"']*(?:member-name|contact-name|user-name|profile-name)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const name = cleanName(match[1]);
    if (name) return name;
  }

  const firstNameMatch = html.match(
    /(?:name|id)=["'][^"']*(?:FirstName|firstName)[^"']*["'][^>]*value=["']([^"']+)["']/i,
  );
  const lastNameMatch = html.match(
    /(?:name|id)=["'][^"']*(?:LastName|lastName)[^"']*["'][^>]*value=["']([^"']+)["']/i,
  );
  const labelledFirstNameMatch = html.match(
    /<label[^>]*>[^<]*First Name[^<]*<\/label>[\s\S]{0,500}?<input[^>]*value=["']([^"']+)["']/i,
  );
  const labelledLastNameMatch = html.match(
    /<label[^>]*>[^<]*Last Name[^<]*<\/label>[\s\S]{0,500}?<input[^>]*value=["']([^"']+)["']/i,
  );
  const fullName = cleanName(
    `${firstNameMatch?.[1] || labelledFirstNameMatch?.[1] || ""} ${
      lastNameMatch?.[1] || labelledLastNameMatch?.[1] || ""
    }`,
  );

  return fullName;
}

export async function fetchFullName(cookie) {
  for (const url of [CONTACT_URL, BOOKING_URL]) {
    const pageResponse = await fetch(url, {
      headers: {
        Accept: "text/html",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (!pageResponse.ok) continue;
    const html = await pageResponse.text();
    if (html.includes("MemberSignIn") && html.includes("textBoxPassword")) continue;
    const fullName = extractFullName(html);
    if (fullName) return fullName;
  }

  return "";
}

export async function verifyPerfectMindLogin(email, password, returnUrl = BOOKING_URL) {
  const url = loginUrl(returnUrl);
  const loginPath = loginPathForReturnUrl(returnUrl);
  const loginResponse = await fetch(url, {
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
    returnUrl,
    username: email,
    password,
    bsubmit: "Login",
  });

  const verifyResponse = await fetch(`${BASE_URL}${loginPath}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(loginCookies),
      Origin: BASE_URL,
      Referer: url,
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });

  const initialCookie = cookieHeader([
    ...loginCookies,
    ...setCookieValues(verifyResponse.headers),
  ]);
  const location = verifyResponse.headers.get("location") || "";
  const redirectedAwayFromLogin =
    verifyResponse.status >= 300 &&
    verifyResponse.status < 400 &&
    location &&
    !location.includes("MemberSignIn");

  if (!redirectedAwayFromLogin) {
    throw new Error("City of Markham login failed.");
  }

  const redirectResult = await followLoginRedirects(location, initialCookie);
  const cookie = redirectResult.cookie;
  const fullName = await fetchFullName(cookie);

  return {
    verifiedAt: new Date().toISOString(),
    returnUrl,
    location,
    finalUrl: redirectResult.finalUrl,
    redirects: redirectResult.redirects,
    cookie,
    fullName,
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
          account_credentials.email,
          account_credentials.full_name,
          account_credentials.updated_at,
          account_attendees.full_name as attendee_name
        from account_credentials
        left join account_attendees
          on account_attendees.id = account_credentials.default_attendee_id
        where account_credentials.device_id = ${deviceId}
        limit 1
      `;

      const displayName = rows[0]?.attendee_name || rows[0]?.full_name || "";
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        hasAccount: rows.length > 0,
        email: rows[0]?.email || "",
        fullName: rows[0]?.full_name || "",
        displayName,
        defaultAttendeeName: rows[0]?.attendee_name || "",
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

      const accountRows = await db`
        insert into account_credentials (
          device_id,
          email,
          full_name,
          password_cipher,
          password_iv,
          password_tag,
          user_agent,
          session
        )
        values (
          ${body.deviceId},
          ${body.email.trim()},
          ${loginSession.fullName || null},
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
          full_name = coalesce(excluded.full_name, account_credentials.full_name),
          password_cipher = excluded.password_cipher,
          password_iv = excluded.password_iv,
          password_tag = excluded.password_tag,
          user_agent = excluded.user_agent,
          session = excluded.session,
          updated_at = now()
        returning id
      `;
      const accountId = accountRows[0].id;
      const attendeeSync = await syncAttendeesFromOfficialSite(
        db,
        accountId,
        loginSession.cookie,
        {
          email: body.email.trim(),
          password: body.password,
        },
      );

      const displayRows = await db`
        select
          account_credentials.full_name,
          account_attendees.full_name as attendee_name
        from account_credentials
        left join account_attendees
          on account_attendees.id = account_credentials.default_attendee_id
        where account_credentials.device_id = ${body.deviceId}
        limit 1
      `;
      const displayName =
        displayRows[0]?.attendee_name || displayRows[0]?.full_name || "";

      response.status(200).json({
        ok: true,
        hasAccount: true,
        email: body.email.trim(),
        fullName: displayRows[0]?.full_name || loginSession.fullName || "",
        displayName,
        attendeeSync,
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
