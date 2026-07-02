import { decryptText } from "./crypto.js";

const BASE_URL = "https://cityofmarkham.perfectmind.com";
const CONTACT_URL = `${BASE_URL}/Clients/Contact`;

function mergeCookie(existingCookie, response) {
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
      if (pair.endsWith("=")) cookiePairs.delete(name);
      else cookiePairs.set(name, pair);
    });

  return [...cookiePairs.values()].join("; ");
}

function extractAttributes(attrs) {
  const values = {};
  for (const match of String(attrs || "").matchAll(/\b([a-z0-9_-]+)=["']([^"']*)["']/gi)) {
    values[match[1].toLowerCase()] = match[2];
  }
  return values;
}

function loginForm(html) {
  const formHtml =
    html.match(/<form\b[^>]*id=["']logonform["'][\s\S]*?<\/form>/i)?.[0] || "";
  const formAttrs = extractAttributes(formHtml.match(/<form\b([^>]*)>/i)?.[1] || "");
  const body = new URLSearchParams();
  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    if (attrs.name) body.set(attrs.name, attrs.value || "");
  }

  return {
    action: new URL(formAttrs.action || "/SocialSite/MemberRegistration/MemberSignIn", BASE_URL)
      .toString(),
    body,
  };
}

async function loginForContact(account) {
  const password = decryptText({
    cipher: account.password_cipher,
    iv: account.password_iv,
    tag: account.password_tag,
  });
  const loginUrl = `${BASE_URL}/SocialSite/MemberRegistration/MemberSignIn?returnUrl=${encodeURIComponent(CONTACT_URL)}`;
  const loginPage = await fetch(loginUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!loginPage.ok) throw new Error("Could not open City of Markham login.");

  let cookie = mergeCookie("", loginPage);
  const form = loginForm(await loginPage.text());
  form.body.set("returnUrl", CONTACT_URL);
  form.body.set("username", account.email);
  form.body.set("password", password);
  form.body.set("bsubmit", "Login");

  let response = await fetch(form.action, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Origin: BASE_URL,
      Referer: loginUrl,
      "User-Agent": "Mozilla/5.0",
    },
    body: form.body,
  });
  cookie = mergeCookie(cookie, response);

  let url = new URL(response.headers.get("location") || CONTACT_URL, BASE_URL).toString();
  for (let index = 0; index < 8; index += 1) {
    response = await fetch(url, {
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });
    cookie = mergeCookie(cookie, response);
    const location = response.headers.get("location") || "";
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    await response.text();
    if (url.includes("MemberSignIn")) {
      throw new Error("City of Markham contact login failed.");
    }
    return cookie;
  }

  throw new Error("City of Markham contact login did not finish.");
}

function zonedParts(date, options = {}) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    ...options,
  }).formatToParts(date);
  return (type) => parts.find((part) => part.type === type)?.value || "";
}

function ordinal(day) {
  const value = Number(day);
  if (value >= 11 && value <= 13) return `${value}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th";
  return `${value}${suffix}`;
}

function formatSessionDate(date) {
  const part = zonedParts(date, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${part("weekday")}, ${part("month")} ${ordinal(part("day"))}, ${part("year")}`;
}

function formatSessionTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .toLowerCase();
}

function occurrenceDate(date) {
  const part = zonedParts(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${part("year")}${part("month")}${part("day")}`;
}

function parseDotNetDate(value) {
  const timestamp = String(value || "").match(/\/Date\((\d+)\)\//)?.[1];
  if (!timestamp) return null;
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeScheduleEvent(event) {
  const start = parseDotNetDate(event.Start);
  const end = parseDotNetDate(event.End);
  const timeRange =
    start && end ? `${formatSessionTime(start)} - ${formatSessionTime(end)}` : event.EventTimes || "";

  return {
    eventId: event.RecordId || "",
    attendanceId: event.AttendanceId || "",
    contactId: event.ContactId || "",
    occurrenceDate: start ? occurrenceDate(start) : "",
    service: event.Title || "Registered activity",
    date: start ? formatSessionDate(start) : event.StartDate || "",
    timeRange,
    location: event.LocationName || event.FacilityName || "",
    facility: event.FacilityName || "",
    spots: "Registered",
    action: "Registered",
    startDateTime: start ? start.toISOString() : "",
    endDateTime: end ? end.toISOString() : "",
    url: event.RecordId && start
      ? `${BASE_URL}/Clients/BookMe4LandingPages/Class?widgetId=6825ea71-e5b7-4c2a-948f-9195507ad90a&redirectedFromEmbededMode=False&classId=${event.RecordId}&occurrenceDate=${occurrenceDate(start)}`
      : "",
  };
}

export async function fetchOfficialScheduleEvents(account, attendees, options = {}) {
  const records = [...new Map(
    attendees
      .filter((attendee) => attendee.member_id)
      .map((attendee) => [attendee.member_id, attendee]),
  ).values()];
  if (!records.length) return [];

  const cookie = await loginForContact(account);
  const body = new URLSearchParams();
  body.set("exportType", "0");
  records.forEach((attendee) => body.append("recordsId", attendee.member_id));
  body.set(
    "startDate",
    (options.startDate || new Date(Date.now() - 24 * 60 * 60 * 1000)).toUTCString(),
  );
  body.set(
    "endDate",
    (options.endDate || new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)).toUTCString(),
  );

  const response = await fetch(`${BASE_URL}/Classes/ExportSchedule/GetContactsScheduleEvents`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookie,
      Origin: BASE_URL,
      Referer: CONTACT_URL,
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Official schedule request failed: ${response.status}`);
  }

  const events = await response.json();
  return Array.isArray(events) ? events : [];
}
