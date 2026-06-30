import { decryptText } from "./crypto.js";
import { verifyPerfectMindLogin } from "./account.js";
import { ensureQueueSchema, getSql } from "./db.js";

const BASE_URL = "https://cityofmarkham.perfectmind.com";
const DEFAULT_DRY_RUN = true;
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function validateDeviceId(deviceId) {
  if (typeof deviceId !== "string" || deviceId.length < 8) {
    throw new Error("A valid deviceId is required.");
  }
}

function htmlDecode(value) {
  return String(value || "")
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

function safeText(value, max = 160) {
  return stripTags(value).slice(0, max);
}

function absoluteUrl(href, base = BASE_URL) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return "";
  try {
    return new URL(htmlDecode(href), base).toString();
  } catch {
    return "";
  }
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

function isLoginPage(html, url) {
  return (
    url.includes("MemberSignIn") ||
    (html.includes("textBoxPassword") && html.includes("logonform"))
  );
}

function pageTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return safeText(title || h1 || "");
}

async function fetchHtmlWithRedirects(url, initialCookie) {
  let currentUrl = absoluteUrl(url);
  let cookie = initialCookie;
  const redirects = [];
  let response;
  let html = "";

  for (let index = 0; index < 8; index += 1) {
    response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });

    cookie = mergeCookieHeader(cookie, response);
    const location = response.headers.get("location") || "";
    if (response.status >= 300 && response.status < 400 && location) {
      currentUrl = absoluteUrl(location, currentUrl);
      redirects.push(currentUrl);
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    html = contentType.includes("text/html") ? await response.text() : "";
    break;
  }

  return { response, finalUrl: currentUrl, redirects, html, cookie };
}

function extractAttributes(attrs) {
  const values = {};
  for (const match of attrs.matchAll(/\b([a-z0-9_-]+)=["']([^"']*)["']/gi)) {
    values[match[1].toLowerCase()] = htmlDecode(match[2]);
  }
  return values;
}

function extractForms(html, baseUrl) {
  return [...html.matchAll(/<form\b([^>]*)>/gi)].slice(0, 12).map((match) => {
    const attrs = extractAttributes(match[1]);
    return {
      id: attrs.id || "",
      name: attrs.name || "",
      action: absoluteUrl(attrs.action || baseUrl, baseUrl),
      method: (attrs.method || "get").toUpperCase(),
    };
  });
}

function extractButtons(html) {
  const buttons = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = extractAttributes(match[1]);
    buttons.push({
      text: safeText(match[2], 80),
      id: attrs.id || "",
      name: attrs.name || "",
      type: attrs.type || "",
      disabled: "disabled" in attrs || /\bdisabled\b/i.test(match[1]),
    });
  }

  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    const type = attrs.type || "";
    if (!/^(button|submit)$/i.test(type)) continue;
    buttons.push({
      text: safeText(attrs.value || attrs.title || "", 80),
      id: attrs.id || "",
      name: attrs.name || "",
      type,
      disabled: "disabled" in attrs || /\bdisabled\b/i.test(match[1]),
    });
  }

  const interesting = /(register|book|add to cart|checkout|waitlist|reserve|sign in|login)/i;
  return buttons
    .filter((button) => interesting.test(`${button.text} ${button.id} ${button.name}`))
    .slice(0, 20);
}

function extractLinks(html, baseUrl) {
  const interesting =
    /(register|book|cart|checkout|class|event|course|waitlist|basket|order|transaction)/i;

  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => {
      const attrs = extractAttributes(match[1]);
      return {
        text: safeText(match[2], 80),
        href: absoluteUrl(attrs.href || "", baseUrl),
      };
    })
    .filter((link) => link.href && interesting.test(`${link.text} ${link.href}`))
    .slice(0, 30);
}

function extractApiHints(html, baseUrl) {
  const hints = new Set();
  const patterns = [
    /["'](\/(?:Clients|SocialSite)\/[^"']*(?:Book|Booking|Cart|Checkout|Class|Course|Event|Member|Registration|Reservation|Transaction|Waitlist)[^"']*)["']/gi,
    /\burl:\s*["']([^"']+)["']/gi,
    /\baction=["']([^"']+)["']/gi,
    /\bdata-url=["']([^"']+)["']/gi,
  ];

  patterns.forEach((pattern) => {
    for (const match of html.matchAll(pattern)) {
      const url = absoluteUrl(match[1], baseUrl);
      if (/perfectmind\.com\/(?:Clients|SocialSite)\//i.test(url)) hints.add(url);
    }
  });

  return [...hints].slice(0, 60);
}

function extractHiddenInputs(html) {
  return [...html.matchAll(/<input\b([^>]*)>/gi)]
    .map((match) => extractAttributes(match[1]))
    .filter((attrs) => (attrs.type || "").toLowerCase() === "hidden")
    .map((attrs) => ({
      name: attrs.name || "",
      id: attrs.id || "",
      hasValue: Boolean(attrs.value),
    }))
    .filter((input) => input.name || input.id)
    .slice(0, 40);
}

function extractRegisterHints(html, baseUrl) {
  return {
    title: pageTitle(html),
    looksLoggedIn: !isLoginPage(html, baseUrl),
    forms: extractForms(html, baseUrl),
    buttons: extractButtons(html),
    links: extractLinks(html, baseUrl),
    apiHints: extractApiHints(html, baseUrl),
    hiddenInputs: extractHiddenInputs(html),
  };
}

function findRegisterUrl(hints) {
  const registerLink = (hints.links || []).find((link) =>
    /\/Clients\/BookMe4EventParticipants\b/i.test(link.href),
  );
  if (registerLink?.href) return registerLink.href;

  return (hints.apiHints || []).find((url) =>
    /\/Clients\/BookMe4EventParticipants\b/i.test(url),
  ) || "";
}

function socialSiteRegisterUrl(registerUrl) {
  if (!registerUrl) return "";
  return registerUrl.replace(
    "/Clients/BookMe4EventParticipants",
    "/SocialSite/BookMe4EventParticipants",
  );
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function sessionSummary(row) {
  const session = row.session || {};
  return {
    id: row.id,
    key: row.session_key,
    status: row.status,
    service: session.service || "",
    date: session.date || "",
    timeRange: session.timeRange || "",
    location: session.location || "",
    spots: session.spots || "",
    action: session.action || "",
    url: session.url || "",
    startAt: row.start_at,
    endAt: row.end_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error || "",
  };
}

function parseClock(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function markhamOffsetHours(monthIndex) {
  return monthIndex >= 2 && monthIndex <= 10 ? 4 : 5;
}

function markhamDateToIso(year, monthIndex, day, clock) {
  const utcHour = clock.hour + markhamOffsetHours(monthIndex);
  return new Date(Date.UTC(year, monthIndex, day, utcHour, clock.minute)).toISOString();
}

function inferSessionTimes(session) {
  if (!session) return { startAt: null, endAt: null };
  const startDate = session.startDateTime ? new Date(session.startDateTime) : null;
  const endDate = session.endDateTime ? new Date(session.endDateTime) : null;
  if (
    startDate &&
    endDate &&
    !Number.isNaN(startDate.getTime()) &&
    !Number.isNaN(endDate.getTime())
  ) {
    return { startAt: startDate.toISOString(), endAt: endDate.toISOString() };
  }

  const dateMatch = String(session.date || "").match(
    /\b([A-Za-z]{3})\w*\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\b/,
  );
  const timeMatch = String(session.timeRange || "").match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
  );
  if (!dateMatch || !timeMatch) return { startAt: null, endAt: null };

  const monthIndex = MONTHS[dateMatch[1].slice(0, 3).toLowerCase()];
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  const startClock = parseClock(timeMatch[1]);
  const endClock = parseClock(timeMatch[2]);
  if (monthIndex === undefined || !startClock || !endClock) {
    return { startAt: null, endAt: null };
  }

  let startAt = markhamDateToIso(year, monthIndex, day, startClock);
  let endAt = markhamDateToIso(year, monthIndex, day, endClock);
  if (new Date(endAt) <= new Date(startAt)) {
    endAt = markhamDateToIso(year, monthIndex, day + 1, endClock);
  }

  return { startAt, endAt };
}

async function backfillSessionTimes(db, row, inferredTimes) {
  if (!inferredTimes.startAt && !inferredTimes.endAt) return;
  if (row.start_at && row.end_at) return;

  await db`
    update queued_sessions
    set
      start_at = coalesce(start_at, ${inferredTimes.startAt}),
      end_at = coalesce(end_at, ${inferredTimes.endAt}),
      updated_at = now()
    where id = ${row.id}
  `;

  row.start_at = row.start_at || inferredTimes.startAt;
  row.end_at = row.end_at || inferredTimes.endAt;
}

async function markAttempt(db, id, message) {
  await db`
    update queued_sessions
    set
      last_attempt_at = now(),
      last_error = ${message},
      updated_at = now()
    where id = ${id}
  `;
}

async function markExpired(db, id) {
  await db`
    update queued_sessions
    set
      status = 'expired',
      last_attempt_at = now(),
      last_error = 'Session has ended.',
      updated_at = now()
    where id = ${id}
  `;
}

async function selectQueuedSession(db, deviceId, requestedKey) {
  const key = typeof requestedKey === "string" ? requestedKey : "";
  const rows = key
    ? await db`
        select *
        from queued_sessions
        where device_id = ${deviceId}
          and session_key = ${key}
          and status = 'queued'
        limit 1
      `
    : await db`
        select *
        from queued_sessions
        where device_id = ${deviceId}
          and status = 'queued'
        order by
          start_at nulls last,
          created_at
        limit 30
      `;

  const now = new Date();
  const expired = [];
  for (const row of rows) {
    const inferredTimes = inferSessionTimes(row.session);
    await backfillSessionTimes(db, row, inferredTimes);

    if (row.end_at && new Date(row.end_at) < now) {
      await markExpired(db, row.id);
      expired.push(sessionSummary(row));
      continue;
    }

    return { queued: row, expired };
  }

  return { queued: null, expired };
}

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await ensureQueueSchema();
    const db = getSql();
    const deviceId =
      typeof request.query.deviceId === "string" ? request.query.deviceId : "";
    validateDeviceId(deviceId);

    const dryRun =
      request.query.dryRun === undefined
        ? DEFAULT_DRY_RUN
        : request.query.dryRun !== "false";
    const selection = await selectQueuedSession(db, deviceId, request.query.key);
    const queued = selection.queued;
    if (!queued) {
      response.status(404).json({
        error: "No active queued session found for this device.",
        expired: selection.expired,
      });
      return;
    }

    const accounts = await db`
      select *
      from account_credentials
      where device_id = ${deviceId}
      limit 1
    `;
    if (!accounts.length) {
      throw new Error("No saved login for this device.");
    }

    const account = accounts[0];
    const password = decryptText({
      cipher: account.password_cipher,
      iv: account.password_iv,
      tag: account.password_tag,
    });
    const classUrl = queued.session?.url;
    if (!classUrl) throw new Error("Queued session does not have a class URL.");

    const login = await verifyPerfectMindLogin(account.email, password, classUrl);
    const classPage = await fetchHtmlWithRedirects(classUrl, login.cookie);
    const hints = classPage.html
      ? extractRegisterHints(classPage.html, classPage.finalUrl)
      : {
          title: "",
          looksLoggedIn: false,
          forms: [],
          buttons: [],
          links: [],
          apiHints: [],
          hiddenInputs: [],
        };
    const registerUrl = findRegisterUrl(hints);
    const registerCandidates = uniqueUrls([
      registerUrl,
      socialSiteRegisterUrl(registerUrl),
    ]);
    const participantProbes = [];

    for (const url of registerCandidates) {
      const directPage = await fetchHtmlWithRedirects(
        url,
        classPage.cookie || login.cookie,
      );
      let directHints = directPage.html
        ? extractRegisterHints(directPage.html, directPage.finalUrl)
        : null;

      if (!directHints?.looksLoggedIn) {
        const participantLogin = await verifyPerfectMindLogin(
          account.email,
          password,
          url,
        );
        const reloggedPage = await fetchHtmlWithRedirects(
          url,
          participantLogin.cookie,
        );
        directHints = reloggedPage.html
          ? extractRegisterHints(reloggedPage.html, reloggedPage.finalUrl)
          : null;
        participantProbes.push({
          url,
          loginFinalUrl: participantLogin.finalUrl || "",
          loginRedirects: participantLogin.redirects || [],
          status: reloggedPage.response?.status || 0,
          finalUrl: reloggedPage.finalUrl,
          redirects: reloggedPage.redirects,
          looksLoggedIn: directHints?.looksLoggedIn || false,
          hints: directHints,
        });
        continue;
      }

      participantProbes.push({
        url,
        loginFinalUrl: "",
        loginRedirects: [],
        status: directPage.response?.status || 0,
        finalUrl: directPage.finalUrl,
        redirects: directPage.redirects,
        looksLoggedIn: directHints?.looksLoggedIn || false,
        hints: directHints,
      });
    }

    const supportedLiveRegistration = false;
    const message = supportedLiveRegistration
      ? "Registration flow is ready."
      : "Dry-run probe finished. Live registration is not enabled until the exact official flow is confirmed.";
    await markAttempt(db, queued.id, message);

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      ok: true,
      dryRun,
      liveRegistrationEnabled: supportedLiveRegistration && !dryRun,
      message,
      expiredSkipped: selection.expired,
      queued: sessionSummary(queued),
      login: {
        ok: true,
        finalUrl: login.finalUrl || "",
        redirects: login.redirects || [],
        fullName: login.fullName || "",
      },
      classPage: {
        status: classPage.response?.status || 0,
        finalUrl: classPage.finalUrl,
        redirects: classPage.redirects,
        looksLoggedIn: hints.looksLoggedIn,
      },
      registerHints: hints,
      registerUrl,
      registerCandidates,
      participantProbes,
    });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
