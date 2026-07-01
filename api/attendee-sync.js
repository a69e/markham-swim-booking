const BASE_URL = "https://cityofmarkham.perfectmind.com";
const CALENDAR_ID = "39bd5c76-e07f-43f3-af24-c6969091dbb4";
const WIDGET_ID = "6825ea71-e5b7-4c2a-948f-9195507ad90a";
const BOOKING_URL =
  `${BASE_URL}/Clients/BookMe4BookingPages/Classes?calendarId=${CALENDAR_ID}` +
  `&widgetId=${WIDGET_ID}&embed=False`;
const CLASSES_URL = `${BASE_URL}/Clients/BookMe4BookingPagesV2/ClassesV2`;

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function absoluteUrl(href, base = BASE_URL) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return "";
  try {
    return new URL(htmlDecode(href), base).toString();
  } catch {
    return "";
  }
}

function stripTags(value) {
  return htmlDecode(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value, max = 160) {
  return stripTags(value).slice(0, max);
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

async function fetchHtmlWithRedirects(url, initialCookie = "") {
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

function isLoginPage(html, url) {
  return (
    url.includes("MemberSignIn") ||
    (html.includes("textBoxPassword") && html.includes("logonform"))
  );
}

function extractToken(html) {
  const match = html.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/,
  );
  if (!match) throw new Error("Could not find PerfectMind request token.");
  return match[1];
}

function bookingUrl(item) {
  if (!item.EventId || !item.OccurrenceDate) return "";
  const params = new URLSearchParams({
    widgetId: WIDGET_ID,
    redirectedFromEmbededMode: "False",
    classId: item.EventId,
    occurrenceDate: item.OccurrenceDate,
  });
  return `${BASE_URL}/Clients/BookMe4LandingPages/Class?${params}`;
}

function extractLinks(html, baseUrl) {
  const interesting = /(register|book|cart|checkout|class|event|waitlist)/i;
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => {
      const attrs = extractAttributes(match[1]);
      return {
        text: safeText(match[2], 80),
        href: absoluteUrl(attrs.href || "", baseUrl),
      };
    })
    .filter((link) => link.href && interesting.test(`${link.text} ${link.href}`));
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

  return [...hints];
}

function findRegisterUrl(html, baseUrl) {
  const registerLink = extractLinks(html, baseUrl).find((link) =>
    /\/Clients\/BookMe4EventParticipants\b/i.test(link.href),
  );
  if (registerLink?.href) return registerLink.href;

  return (
    extractApiHints(html, baseUrl).find((url) =>
      /\/Clients\/BookMe4EventParticipants\b/i.test(url),
    ) || ""
  );
}

function extractFormHtml(html, id) {
  const formMatch = html.match(
    new RegExp(`<form\\b[^>]*id=["']${id}["'][\\s\\S]*?<\\/form>`, "i"),
  );
  return formMatch ? formMatch[0] : "";
}

function formAction(formHtml, baseUrl) {
  const formAttrs = extractAttributes(formHtml.match(/<form\b([^>]*)>/i)?.[1] || "");
  return absoluteUrl(formAttrs.action || baseUrl, baseUrl);
}

function extractLoginForm(html, baseUrl) {
  const formHtml = extractFormHtml(html, "logonform");
  if (!formHtml) return null;

  const body = new URLSearchParams();
  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    if (!attrs.name) continue;
    body.set(attrs.name, attrs.value || "");
  }

  return {
    action: formAction(formHtml, baseUrl),
    body,
  };
}

async function submitLoginForm(loginPage, email, password) {
  if (!email || !password) return null;
  const form = extractLoginForm(loginPage.html || "", loginPage.finalUrl);
  if (!form) return null;

  form.body.set("username", email);
  form.body.set("password", password);
  form.body.set("bsubmit", "Login");

  let cookie = loginPage.cookie || "";
  let currentUrl = form.action;
  const redirects = [];
  let response = await fetch(currentUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Origin: BASE_URL,
      Referer: loginPage.finalUrl,
      "User-Agent": "Mozilla/5.0",
    },
    body: form.body,
  });
  cookie = mergeCookieHeader(cookie, response);

  let html = "";
  for (let index = 0; index < 8; index += 1) {
    const location = response.headers.get("location") || "";
    if (response.status < 300 || response.status >= 400 || !location) {
      const contentType = response.headers.get("content-type") || "";
      html = contentType.includes("text/html") ? await response.text() : "";
      break;
    }

    currentUrl = absoluteUrl(location, currentUrl);
    redirects.push(currentUrl);
    response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
    });
    cookie = mergeCookieHeader(cookie, response);
  }

  return { response, finalUrl: currentUrl, redirects, html, cookie };
}

function socialSiteRegisterUrl(registerUrl) {
  if (!registerUrl) return "";
  return registerUrl.replace(
    "/Clients/BookMe4EventParticipants",
    "/SocialSite/BookMe4EventParticipants",
  );
}

async function fetchClassCandidates() {
  const bookingResponse = await fetch(BOOKING_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!bookingResponse.ok) {
    throw new Error("Could not open City of Markham classes.");
  }

  const cookie = mergeCookieHeader("", bookingResponse);
  const html = await bookingResponse.text();
  const token = extractToken(html);
  const body = new URLSearchParams({
    calendarId: CALENDAR_ID,
    widgetId: WIDGET_ID,
    page: "0",
    __RequestVerificationToken: token,
  });

  const classesResponse = await fetch(CLASSES_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookie,
      Origin: BASE_URL,
      Referer: BOOKING_URL,
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!classesResponse.ok) {
    throw new Error("Could not load City of Markham classes.");
  }

  const payload = await classesResponse.json();
  return (payload.classes || [])
    .map((item) => ({
      action: item.BookButtonText || item.ClosedButtonName || "",
      url: bookingUrl(item),
    }))
    .filter((item) => item.url)
    .sort((a, b) => {
      const aScore = /register/i.test(a.action) ? 0 : 1;
      const bScore = /register/i.test(b.action) ? 0 : 1;
      return aScore - bScore;
    })
    .slice(0, 8);
}

function extractPriceMap(html) {
  const priceMap = new Map();
  for (const match of html.matchAll(/"Prices":(\[[\s\S]*?\])[,}]/g)) {
    try {
      const prices = JSON.parse(match[1]);
      prices.forEach((price) => {
        if (!price.PriceTypeId) return;
        priceMap.set(price.PriceTypeId, {
          name: price.Name || "",
          display: price.DisplayAmountOrAsFree || price.DisplayAmount || "",
          amount:
            typeof price.Amount === "number"
              ? price.Amount
              : Number(price.Amount || 0),
        });
      });
    } catch {
      // Some embedded price arrays are not standalone JSON fragments.
    }
  }
  return priceMap;
}

export function extractAttendeeRecords(html) {
  const priceMap = extractPriceMap(html);
  const records = [];
  const memberPattern =
    /name="ParticipantsFamily\.FamilyMembers\[(\d+)\]\.MemberId"[^>]*value="([^"]+)"[\s\S]*?name="ParticipantsFamily\.FamilyMembers\[\1\]\.AccountId"[^>]*value="([^"]*)"[\s\S]*?name="ParticipantsFamily\.FamilyMembers\[\1\]\.FullNameSimple"[^>]*value="([^"]+)"[\s\S]*?name="ParticipantsFamily\.FamilyMembers\[\1\]\.FamilyMembership"[^>]*value="([^"]*)"[\s\S]*?name="ParticipantsFamily\.FamilyMembers\[\1\]\.PriceTypeId"[^>]*value="([^"]*)"/g;

  for (const match of html.matchAll(memberPattern)) {
    const price = priceMap.get(match[6]) || {};
    records.push({
      index: match[1],
      memberId: htmlDecode(match[2]),
      accountMemberId: htmlDecode(match[3]),
      fullName: htmlDecode(match[4]),
      familyMembership: htmlDecode(match[5]),
      priceTypeId: htmlDecode(match[6]),
      priceName: price.name || "",
      priceDisplay: price.display || "",
      priceAmount: Number.isFinite(price.amount) ? price.amount : null,
      isOwner: /^you$/i.test(htmlDecode(match[5])),
      hasFreePass:
        Number(price.amount) === 0 &&
        /(pass|membership|free)/i.test(`${price.name || ""} ${price.display || ""}`),
    });
  }

  return records;
}

export async function saveAttendees(db, accountId, html) {
  const attendees = extractAttendeeRecords(html);
  if (!attendees.length) return [];

  for (const attendee of attendees) {
    await db`
      insert into account_attendees (
        account_id,
        member_id,
        account_member_id,
        full_name,
        family_membership,
        price_type_id,
        price_name,
        price_display,
        price_amount,
        is_owner,
        has_free_pass,
        is_default
      )
      values (
        ${accountId},
        ${attendee.memberId},
        ${attendee.accountMemberId || null},
        ${attendee.fullName},
        ${attendee.familyMembership || null},
        ${attendee.priceTypeId || null},
        ${attendee.priceName || null},
        ${attendee.priceDisplay || null},
        ${attendee.priceAmount},
        ${attendee.isOwner},
        ${attendee.hasFreePass},
        ${attendee.isOwner}
      )
      on conflict (account_id, member_id)
      do update set
        account_member_id = excluded.account_member_id,
        full_name = excluded.full_name,
        family_membership = excluded.family_membership,
        price_type_id = excluded.price_type_id,
        price_name = excluded.price_name,
        price_display = excluded.price_display,
        price_amount = excluded.price_amount,
        is_owner = excluded.is_owner,
        has_free_pass = excluded.has_free_pass,
        is_default = case
          when account_attendees.is_default then true
          else excluded.is_default
        end,
        updated_at = now()
    `;
  }

  const ownerRows = await db`
    select id, full_name
    from account_attendees
    where account_id = ${accountId}
      and is_owner = true
    order by id
    limit 1
  `;
  const existingDefaultRows = await db`
    select id, full_name
    from account_attendees
    where account_id = ${accountId}
      and is_default = true
    order by id
    limit 1
  `;
  const defaultRow = existingDefaultRows[0] || ownerRows[0] || null;

  if (defaultRow) {
    await db`
      update account_attendees
      set is_default = id = ${defaultRow.id},
          updated_at = now()
      where account_id = ${accountId}
    `;
    await db`
      update account_credentials
      set default_attendee_id = ${defaultRow.id},
          full_name = ${defaultRow.full_name},
          updated_at = now()
      where id = ${accountId}
    `;
  }

  return attendees;
}

export async function syncAttendeesFromOfficialSite(
  db,
  accountId,
  cookie,
  credentials = {},
) {
  const candidates = await fetchClassCandidates();
  const errors = [];

  for (const candidate of candidates) {
    const classPage = await fetchHtmlWithRedirects(candidate.url, cookie);
    if (!classPage.html || isLoginPage(classPage.html, classPage.finalUrl)) {
      errors.push("Class page required login.");
      continue;
    }

    const registerUrl = findRegisterUrl(classPage.html, classPage.finalUrl);
    const urls = [
      registerUrl,
      socialSiteRegisterUrl(registerUrl),
    ].filter(Boolean);

    for (const url of [...new Set(urls)]) {
      const attendeePage = await fetchHtmlWithRedirects(
        url,
        classPage.cookie || cookie,
      );
      const loginPage =
        attendeePage.html && isLoginPage(attendeePage.html, attendeePage.finalUrl)
          ? await submitLoginForm(
              attendeePage,
              credentials.email,
              credentials.password,
            )
          : null;
      const finalPage = loginPage?.html ? loginPage : attendeePage;
      if (!finalPage.html || isLoginPage(finalPage.html, finalPage.finalUrl)) {
        errors.push("Attendee page required login.");
        continue;
      }

      const attendees = await saveAttendees(db, accountId, finalPage.html);
      if (attendees.length) {
        return {
          ok: true,
          attendeeCount: attendees.length,
          sourceUrl: finalPage.finalUrl,
        };
      }
      errors.push("No attendees found on attendee page.");
    }
  }

  return {
    ok: false,
    attendeeCount: 0,
    error: errors.at(-1) || "No attendee page could be loaded.",
  };
}
