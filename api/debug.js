import { decryptText, encryptText } from "./crypto.js";
import { verifyPerfectMindLogin } from "./account.js";
import { ensureQueueSchema, getSql } from "./db.js";

const BASE_URL = "https://cityofmarkham.perfectmind.com";
const PROBE_PATHS = [
  "/Clients/Contact",
  "/Clients/BookMe4",
  "/Clients/BookMe4Cart",
  "/Clients/BookMe4CartV2",
  "/Clients/MyBookings",
  "/Clients/Bookings",
  "/Clients/Schedule",
  "/Clients/MemberRegistration",
  "/SocialSite/BookMe4",
];

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.length < 8) {
    throw new Error("A valid deviceId is required.");
  }
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

function absoluteUrl(href) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return "";
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return "";
  }
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}***@${domain}`;
}

function safeText(value, max = 120) {
  return stripTags(value).slice(0, max);
}

function pageTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return safeText(title || h1 || "");
}

function extractForms(html) {
  return [...html.matchAll(/<form\b([^>]*)>/gi)].slice(0, 10).map((match) => {
    const attrs = match[1];
    return {
      id: attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || "",
      action: absoluteUrl(attrs.match(/\baction=["']([^"']+)["']/i)?.[1] || ""),
      method: attrs.match(/\bmethod=["']([^"']+)["']/i)?.[1] || "get",
    };
  });
}

function extractLinks(html) {
  const interesting =
    /(account|booking|book|cart|contact|course|class|event|member|profile|registration|schedule|transaction|order|my info|logout)/i;

  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => {
      const attrs = match[1];
      const href = absoluteUrl(attrs.match(/\bhref=["']([^"']+)["']/i)?.[1] || "");
      return {
        text: safeText(match[2], 80),
        href,
      };
    })
    .filter((link) => link.href && interesting.test(`${link.text} ${link.href}`))
    .slice(0, 30);
}

function extractScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => absoluteUrl(match[1]))
    .filter((src) => /Book|Booking|Cart|Contact|Member|Registration|Schedule/i.test(src))
    .slice(0, 25);
}

function extractApiHints(html) {
  const hints = new Set();
  const patterns = [
    /["'](\/(?:Clients|SocialSite)\/[^"']*(?:Book|Booking|Cart|Contact|Event|Member|Registration|Schedule|Transaction|Order)[^"']*)["']/gi,
    /\burl:\s*["']([^"']+)["']/gi,
    /\baction=["']([^"']+)["']/gi,
  ];

  patterns.forEach((pattern) => {
    for (const match of html.matchAll(pattern)) {
      const url = absoluteUrl(match[1]);
      if (url) hints.add(url);
    }
  });

  return [...hints].slice(0, 50);
}

function extractNameHints(html) {
  const hints = [];
  const labelInputPattern =
    /<label[^>]*>([\s\S]{0,80}?(?:First Name|Last Name|Full Name|Name)[\s\S]{0,80}?)<\/label>[\s\S]{0,500}?<input\b([^>]*)>/gi;

  for (const match of html.matchAll(labelInputPattern)) {
    const attrs = match[2];
    const value = attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
    hints.push({
      label: safeText(match[1], 80),
      inputId: attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || "",
      inputName: attrs.match(/\bname=["']([^"']+)["']/i)?.[1] || "",
      sampleValue: safeText(value, 80),
    });
  }

  const menuName = html.match(
    /id=["']OptionsSelector["'][\s\S]*?<span[^>]*class=["'][^"']*k-link[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  )?.[1];
  if (menuName) {
    hints.unshift({
      label: "Header menu",
      inputId: "",
      inputName: "",
      sampleValue: safeText(menuName, 80),
    });
  }

  return hints.slice(0, 12);
}

function isLoginPage(html, url) {
  return (
    url.includes("MemberSignIn") ||
    (html.includes("textBoxPassword") && html.includes("logonform"))
  );
}

function mergeCookieHeader(existingCookie, response) {
  const rawCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie().join(",")
      : response.headers.get("set-cookie") || "";
  const cookiePairs = new Map();

  [existingCookie, rawCookie]
    .filter(Boolean)
    .flatMap((value) => value.split(/,(?=\s*[^;,]+=[^;,]+)/g))
    .map((cookie) => cookie.trim().split(";")[0])
    .filter(Boolean)
    .forEach((pair) => {
      const name = pair.split("=")[0];
      cookiePairs.set(name, pair);
    });

  return [...cookiePairs.values()].join("; ");
}

async function fetchHtmlWithRedirects(path, initialCookie) {
  let url = absoluteUrl(path);
  let cookie = initialCookie;
  const redirects = [];
  let response;
  let html = "";

  for (let index = 0; index < 5; index += 1) {
    response = await fetch(url, {
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });

    cookie = mergeCookieHeader(cookie, response);
    const location = response.headers.get("location") || "";
    if (response.status >= 300 && response.status < 400 && location) {
      const nextUrl = absoluteUrl(location);
      redirects.push(nextUrl);
      url = nextUrl;
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    html = contentType.includes("text/html") ? await response.text() : "";
    break;
  }

  return { response, finalUrl: url, redirects, html, cookie };
}

async function fetchProbe(path, cookie) {
  const { response, finalUrl, redirects, html } = await fetchHtmlWithRedirects(
    path,
    cookie,
  );
  const url = absoluteUrl(path);

  if (!response) {
    return {
      url,
      status: 0,
      finalUrl,
      redirects,
      title: "",
      looksLoggedIn: false,
      nameHints: [],
      forms: [],
      links: [],
      scripts: [],
      apiHints: [],
    };
  }

  return {
    url,
    status: response.status,
    finalUrl,
    redirects,
    title: html ? pageTitle(html) : "",
    looksLoggedIn: html ? !isLoginPage(html, finalUrl) : false,
    nameHints: html ? extractNameHints(html) : [],
    forms: html ? extractForms(html) : [],
    links: html ? extractLinks(html) : [],
    scripts: html ? extractScripts(html) : [],
    apiHints: html ? extractApiHints(html) : [],
  };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await ensureQueueSchema();
    const deviceId =
      typeof request.query.deviceId === "string" ? request.query.deviceId : "";
    validateDeviceId(deviceId);

    const db = getSql();
    const rows = await db`
      select
        email,
        full_name,
        password_cipher,
        password_iv,
        password_tag,
        session,
        updated_at
      from account_credentials
      where device_id = ${deviceId}
      limit 1
    `;

    if (!rows.length) {
      response.status(404).json({ error: "No saved account for this device." });
      return;
    }

    const savedSession = rows[0].session || {};
    const sessionText = savedSession.cipher
      ? decryptText(savedSession)
      : JSON.stringify({});
    const session = JSON.parse(sessionText);
    let freshLogin = null;
    let freshLoginError = "";
    let cookie = session.cookie || "";

    try {
      const password = decryptText({
        cipher: rows[0].password_cipher,
        iv: rows[0].password_iv,
        tag: rows[0].password_tag,
      });
      freshLogin = await verifyPerfectMindLogin(rows[0].email, password);
      cookie = freshLogin.cookie || cookie;
      const encryptedSession = encryptText(JSON.stringify(freshLogin));
      await db`
        update account_credentials
        set
          full_name = coalesce(${freshLogin.fullName || null}, full_name),
          session = ${JSON.stringify({
            cipher: encryptedSession.cipher,
            iv: encryptedSession.iv,
            tag: encryptedSession.tag,
            verifiedAt: freshLogin.verifiedAt,
          })},
          updated_at = now()
        where device_id = ${deviceId}
      `;
    } catch (error) {
      freshLoginError = error.message;
    }

    if (!cookie) {
      response.status(400).json({ error: "Saved account has no login session." });
      return;
    }

    const probes = [];
    for (const path of PROBE_PATHS) {
      probes.push(await fetchProbe(path, cookie));
    }

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      email: maskEmail(rows[0].email),
      storedFullName: freshLogin?.fullName || rows[0].full_name || "",
      savedSessionVerifiedAt: savedSession.verifiedAt || session.verifiedAt || null,
      freshLogin: {
        ok: Boolean(freshLogin),
        fullName: freshLogin?.fullName || "",
        error: freshLoginError,
      },
      probes,
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
