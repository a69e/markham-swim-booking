import { randomBytes } from "node:crypto";
import { accountScopeForDevice, ensureQueueSchema, getSql } from "../lib/db.js";
import { decryptText, encryptText } from "../lib/crypto.js";
import { verifyPerfectMindLogin } from "./account.js";
import { sendCheckoutNotification } from "../lib/notifications.js";

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

function appBaseUrl() {
  const configured = process.env.APP_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "https://markham-swim-booking.vercel.app";
  return configured.startsWith("http") ? configured : `https://${configured}`;
}

function publicCheckoutUrl(token) {
  return `${appBaseUrl().replace(/\/$/, "")}/api/checkout?token=${encodeURIComponent(token)}`;
}

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

function extractFormHtml(html, id) {
  const formMatch = html.match(
    new RegExp(`<form\\b[^>]*id=["']${id}["'][\\s\\S]*?<\\/form>`, "i"),
  );
  return formMatch ? formMatch[0] : "";
}

function formAction(formHtml, baseUrl) {
  const formAttrs = extractAttributes(formHtml.match(/<form\b([^>]*)>/i)?.[1] || "");
  return {
    action: absoluteUrl(formAttrs.action || baseUrl, baseUrl),
    method: (formAttrs.method || "get").toUpperCase(),
  };
}

function extractLoginForm(html, baseUrl) {
  const formHtml = extractFormHtml(html, "logonform");
  if (!formHtml) return null;

  const { action } = formAction(formHtml, baseUrl);
  const body = new URLSearchParams();

  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    if (!attrs.name) continue;
    body.set(attrs.name, attrs.value || "");
  }

  return {
    action: action || absoluteUrl("/SocialSite/MemberRegistration/MemberSignIn"),
    body,
  };
}

async function submitLoginForm(loginPage, email, password) {
  const form = extractLoginForm(loginPage.html || "", loginPage.finalUrl);
  if (!form) return null;

  form.body.set("username", email);
  form.body.set("password", password);
  form.body.set("bsubmit", "Login");

  const redirects = [];
  let cookie = loginPage.cookie || "";
  let currentUrl = form.action;
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

  return {
    response,
    finalUrl: currentUrl,
    redirects,
    html,
    cookie,
  };
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

function valueKind(value) {
  if (!value) return "empty";
  if (/^(true|false)$/i.test(value)) return "boolean";
  if (/^\d+$/.test(value)) return "number";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return "guid";
  }
  if (/^data:image\//i.test(value)) return "image";
  return "text";
}

function extractFormDetails(html, baseUrl) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
    .slice(0, 8)
    .map((match) => {
      const attrs = extractAttributes(match[1]);
      const formHtml = match[2];
      const controls = [...formHtml.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)]
        .map((controlMatch) => {
          const tag = controlMatch[1].toLowerCase();
          const controlAttrs = extractAttributes(controlMatch[2]);
          const raw = controlMatch[0];
          const text =
            tag === "button"
              ? safeText(
                  formHtml
                    .slice(controlMatch.index)
                    .match(/<button\b[^>]*>([\s\S]*?)<\/button>/i)?.[1] || "",
                  80,
                )
              : "";

          return {
            tag,
            type: controlAttrs.type || "",
            name: controlAttrs.name || "",
            id: controlAttrs.id || "",
            text,
            checked: /\bchecked\b/i.test(raw),
            disabled: /\bdisabled\b/i.test(raw),
            valueKind: valueKind(controlAttrs.value || ""),
            hasValue: Boolean(controlAttrs.value),
            sampleValue: /\.FullNameSimple$/.test(controlAttrs.name || "")
              ? safeText(controlAttrs.value || "", 80)
              : "",
          };
        })
        .filter((control) => control.name || control.id || control.text)
        .slice(0, 80);

      const participantIndexes = [
        ...new Set(
          controls
            .map((control) =>
              control.name.match(/ParticipantsFamily\.FamilyMembers\[(\d+)\]/)?.[1],
            )
            .filter(Boolean),
        ),
      ];

      return {
        id: attrs.id || "",
        name: attrs.name || "",
        action: absoluteUrl(attrs.action || baseUrl, baseUrl),
        method: (attrs.method || "get").toUpperCase(),
        controls,
        participantIndexes,
        participants: participantIndexes.map((index) => {
          const prefix = `ParticipantsFamily.FamilyMembers[${index}]`;
          const nameInput = controls.find(
            (control) => control.name === `${prefix}.FullNameSimple`,
          );
          const memberInput = controls.find(
            (control) => control.name === `${prefix}.MemberId`,
          );
          const checkbox = controls.find(
            (control) =>
              control.name === `${prefix}.IsParticipating` &&
              control.type === "checkbox",
          );

          return {
            index,
            label: nameInput?.sampleValue || "",
            memberValueKind: memberInput?.valueKind || "",
            checked: checkbox?.checked || false,
            disabled: checkbox?.disabled || false,
          };
        }),
      };
    });
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

function extractAttendeeRecords(html) {
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

async function saveAttendees(db, accountId, html) {
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

function participantLabelFromControls(controls, index) {
  const name = controls.find(
    (control) =>
      control.name === `ParticipantsFamily.FamilyMembers[${index}].FullNameSimple`,
  );
  return name?.sampleValue || "";
}

function buildParticipantSelectionPreview(html, baseUrl, selectedIndex) {
  if (selectedIndex === undefined || selectedIndex === null || selectedIndex === "") {
    return null;
  }

  const formHtml = extractFormHtml(html, "eventParticipantsSelection");
  if (!formHtml) return null;

  const details = extractFormDetails(html, baseUrl).find(
    (form) => form.id === "eventParticipantsSelection",
  );
  const participantIndexes = details?.participantIndexes || [];
  const selected = String(selectedIndex);
  if (!participantIndexes.includes(selected)) {
    return {
      error: `Participant index ${selected} was not found.`,
      participantIndexes,
    };
  }

  const body = new URLSearchParams();
  let selectedCheckbox = "";
  let skippedCheckboxes = 0;

  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    if (!attrs.name || /\bdisabled\b/i.test(match[0])) continue;

    const type = (attrs.type || "text").toLowerCase();
    const participantMatch = attrs.name.match(
      /^ParticipantsFamily\.FamilyMembers\[(\d+)\]\.IsParticipating$/,
    );

    if (type === "checkbox") {
      if (participantMatch?.[1] === selected) {
        body.append(attrs.name, attrs.value || "true");
        selectedCheckbox = attrs.name;
      } else {
        skippedCheckboxes += 1;
      }
      continue;
    }

    body.append(attrs.name, attrs.value || "");
  }

  const action = formAction(formHtml, baseUrl);
  return {
    action: action.action,
    method: action.method,
    selectedParticipantIndex: selected,
    selectedParticipantLabel: participantLabelFromControls(
      details?.controls || [],
      selected,
    ),
    participantIndexes,
    selectedCheckbox,
    skippedCheckboxes,
    fieldCount: [...body.keys()].length,
    repeatedFieldCount: [...new Set([...body.keys()])].length,
  };
}

function buildParticipantSelectionSubmission(html, baseUrl, attendee) {
  const formHtml = extractFormHtml(html, "eventParticipantsSelection");
  if (!formHtml) return { error: "Attendee selection form was not found." };

  const details = extractFormDetails(html, baseUrl).find(
    (form) => form.id === "eventParticipantsSelection",
  );
  const participantIndexes = details?.participantIndexes || [];
  const selectedRecord = extractAttendeeRecords(html).find(
    (record) =>
      record.memberId === attendee.member_id ||
      record.fullName.toLowerCase() === String(attendee.full_name || "").toLowerCase(),
  );
  const selected = selectedRecord?.index || "";
  if (!selected || !participantIndexes.includes(selected)) {
    return {
      error: `${attendee.full_name || "Selected attendee"} was not found on the official attendee page.`,
      participantIndexes,
    };
  }

  const body = new URLSearchParams();
  let selectedCheckbox = "";
  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = extractAttributes(match[1]);
    if (!attrs.name || /\bdisabled\b/i.test(match[0])) continue;

    const type = (attrs.type || "text").toLowerCase();
    const participantMatch = attrs.name.match(
      /^ParticipantsFamily\.FamilyMembers\[(\d+)\]\.IsParticipating$/,
    );

    if (type === "checkbox") {
      if (participantMatch?.[1] === selected) {
        body.append(attrs.name, attrs.value || "true");
        selectedCheckbox = attrs.name;
      }
      continue;
    }

    body.append(attrs.name, attrs.value || "");
  }

  if (!selectedCheckbox) {
    return { error: "Could not select attendee checkbox.", participantIndexes };
  }

  const action = formAction(formHtml, baseUrl);
  return {
    action: action.action,
    method: action.method,
    body,
    selectedMemberId: selectedRecord.memberId,
    selectedParticipantIndex: selected,
    selectedParticipantLabel: selectedRecord.fullName,
    selectedCheckbox,
    fieldCount: [...body.keys()].length,
  };
}

function buildFormSubmission(html, baseUrl, formId) {
  const formHtml = extractFormHtml(html, formId);
  if (!formHtml) return null;

  const body = new URLSearchParams();
  for (const match of formHtml.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = extractAttributes(match[2]);
    if (!attrs.name || /\bdisabled\b/i.test(match[0])) continue;

    const type = (attrs.type || "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(match[0])) {
      continue;
    }

    if (tag === "select") {
      const selected = match[0].match(/<option\b[^>]*selected[^>]*value=["']([^"']*)["']/i);
      body.append(attrs.name, selected ? htmlDecode(selected[1]) : attrs.value || "");
      continue;
    }

    body.append(attrs.name, attrs.value || "");
  }

  const action = formAction(formHtml, baseUrl);
  return {
    action: action.action,
    method: action.method,
    body,
    fieldCount: [...body.keys()].length,
  };
}

function extractJsonLiteralAfterLabel(html, label) {
  const labelIndex = html.indexOf(`${label}:`);
  if (labelIndex < 0) return null;

  const start = html.slice(labelIndex).search(/[\[{]/);
  if (start < 0) return null;

  const absoluteStart = labelIndex + start;
  const opener = html[absoluteStart];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = absoluteStart; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) {
      return html.slice(absoluteStart, index + 1);
    }
  }

  return null;
}

function parseJsonLiteralAfterLabel(html, label) {
  const literal = extractJsonLiteralAfterLabel(html, label);
  if (!literal) return null;
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

function extractCartUrl(html, name) {
  const match = html.match(new RegExp(`${name}:\\s*'([^']+)'`, "i"));
  return match ? htmlDecode(match[1]) : "";
}

function parseShoppingCartKey(result) {
  if (!result) return "";
  if (typeof result.json === "string" && /^[0-9a-f-]{36}$/i.test(result.json)) {
    return result.json;
  }
  try {
    const parsed = JSON.parse(result.text || "");
    if (typeof parsed === "string" && /^[0-9a-f-]{36}$/i.test(parsed)) {
      return parsed;
    }
  } catch {
    // The official endpoint can return either a JSON string or an error array.
  }
  return "";
}

async function prepareOnlineStoreCart(html, cookie, referer) {
  const token = extractAjaxAntiForgeryToken(html);
  const cartItems = parseJsonLiteralAfterLabel(html, "cartItems");
  const onlineStoreShoppingCartModel = parseJsonLiteralAfterLabel(
    html,
    "onlineStoreShoppingCartModel",
  );
  const addItemToCartUrl = extractCartUrl(html, "addItemToCartUrl");
  const getOnlineStoreShoppingKeyUrl = extractCartUrl(
    html,
    "getOnlineStoreShoppingKeyUrl",
  );

  if (!token || !cartItems?.length || !onlineStoreShoppingCartModel) {
    return { ok: false, error: "Official cart model was not found." };
  }
  if (!addItemToCartUrl || !getOnlineStoreShoppingKeyUrl) {
    return { ok: false, error: "Official cart endpoints were not found." };
  }

  const addedItems = [];
  let currentCookie = cookie;
  const addResults = [];
  for (const cartItem of cartItems) {
    const addResult = await postAjaxAntiForgery(
      addItemToCartUrl,
      {
        EventId: cartItem.EventId,
        ObjectId: cartItem.ObjectId,
        CartItemMembers: cartItem.CartItemMembers,
        WidgetId: cartItem.WidgetId,
        OccurrenceDate: cartItem.OccurrenceDate,
        FakeEventId: cartItem.FakeEventId,
      },
      currentCookie,
      referer,
      token,
    );
    currentCookie = addResult.cookie || currentCookie;
    addResults.push(safeAjaxResult(addResult));
    if (!addResult.ok || addResult.json?.isSuccess === false) {
      return {
        ok: false,
        error: addResult.json?.errors || "Official add-to-cart failed.",
        addResults,
      };
    }
    addedItems.push(cartItem);
  }

  const keyResult = await postAjaxAntiForgery(
    getOnlineStoreShoppingKeyUrl,
    { jsonModel: JSON.stringify(onlineStoreShoppingCartModel) },
    currentCookie,
    referer,
    token,
  );
  currentCookie = keyResult.cookie || currentCookie;
  const shoppingCartKey = parseShoppingCartKey(keyResult);
  if (!shoppingCartKey) {
    return {
      ok: false,
      error: "Official shopping cart key was not returned.",
      addResults,
      keyResult: safeAjaxResult(keyResult),
    };
  }

  return {
    ok: true,
    cookie: currentCookie,
    shoppingCartKey,
    addedItems: addedItems.length,
    addResults,
    keyResult: safeAjaxResult(keyResult),
  };
}

function extractAjaxAntiForgeryToken(html) {
  const ajaxForm = extractFormHtml(html, "AjaxAntiForgeryForm");
  const ajaxToken = ajaxForm.match(
    /name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i,
  )?.[1];
  if (ajaxToken) return htmlDecode(ajaxToken);

  return htmlDecode(
    html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
      ?.[1] || "",
  );
}

function extractQuotedValue(block, key) {
  const pattern = new RegExp(`${key}:\\s*'([^']*)'`, "i");
  return htmlDecode(block.match(pattern)?.[1] || "");
}

function extractNumberValue(block, key) {
  const pattern = new RegExp(`${key}:\\s*([0-9]+)`, "i");
  const value = block.match(pattern)?.[1] || "";
  return value ? Number(value) : "";
}

function extractEventObjectHoldModel(html) {
  const block = html.match(/var\s+eventObjectHoldModel\s*=\s*{([\s\S]*?)\n\s*};/i)?.[1] || "";
  if (!block) return null;

  return {
    RecordId: extractQuotedValue(block, "RecordId"),
    ObjectId: extractQuotedValue(block, "ObjectId"),
    IsAdmin: extractQuotedValue(block, "IsAdmin") || "false",
    EventInfo: {
      OccurrenceDate: extractQuotedValue(block, "OccurrenceDate"),
      OccurrenceTime: extractQuotedValue(block, "OccurrenceTime"),
      LocationId: extractQuotedValue(block, "LocationId"),
      BookingType: extractNumberValue(block, "BookingType"),
      EventId: extractQuotedValue(block, "EventId"),
      ParentId: extractQuotedValue(block, "ParentId"),
      EventGroupId: extractQuotedValue(block, "EventGroupId"),
      Token: extractQuotedValue(block, "Token"),
    },
  };
}

function appendNestedParam(body, key, value) {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((item) => appendNestedParam(body, `${key}[]`, item));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      appendNestedParam(body, `${key}[${childKey}]`, childValue);
    });
    return;
  }
  body.append(key, String(value));
}

function buildAjaxBody(data, token) {
  const body = new URLSearchParams();
  Object.entries(data || {}).forEach(([key, value]) => appendNestedParam(body, key, value));
  body.append("__RequestVerificationToken", token);
  return body;
}

async function postAjaxAntiForgery(url, data, cookie, referer, token) {
  const response = await fetch(absoluteUrl(url), {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: cookie || "",
      Origin: BASE_URL,
      Referer: referer,
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: buildAjaxBody(data, token),
  });
  const responseCookie = mergeCookieHeader(cookie || "", response);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let json = null;
  if (contentType.includes("json") || /^[\s[{]/.test(text)) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    finalUrl: url,
    cookie: responseCookie,
    text: text.slice(0, 400),
    json,
  };
}

async function prepareOfficialRegistrationHold(html, pageUrl, cookie, submission) {
  const token = extractAjaxAntiForgeryToken(html);
  const holdModel = extractEventObjectHoldModel(html);
  if (!token) {
    return { ok: false, error: "Official anti-forgery token was not found." };
  }
  if (!holdModel?.RecordId || !holdModel?.ObjectId || !holdModel?.EventInfo?.EventId) {
    return { ok: false, error: "Official hold model was not found." };
  }
  if (!submission?.selectedMemberId) {
    return { ok: false, error: "Selected attendee member id was not found." };
  }

  const canBook = await postAjaxAntiForgery(
    "/SocialSite/BookMe4Extras/CanBookMember",
    {
      eventId: holdModel.EventInfo.EventId,
      widgetId: "6825ea71-e5b7-4c2a-948f-9195507ad90a",
      occurrenceDate: holdModel.EventInfo.OccurrenceDate,
      memberId: submission.selectedMemberId,
      otherSelectedMembersIds: [],
    },
    cookie,
    pageUrl,
    token,
  );
  if (canBook.json && canBook.json.canBookMember === false) {
    return {
      ok: false,
      error: canBook.json.popupText || canBook.json.title || "Selected attendee cannot book this session.",
      canBook,
    };
  }
  if (!canBook.ok) {
    return { ok: false, error: "Official membership check failed.", canBook };
  }

  const hold = await postAjaxAntiForgery(
    "/SocialSite/ObjectHolds/CreateEventHold",
    {
      ContactId: submission.selectedMemberId,
      ...holdModel,
    },
    cookie,
    pageUrl,
    token,
  );
  const holdFailed = !hold.ok || (hold.json && hold.json.succeed === false);
  if (holdFailed) {
    return {
      ok: false,
      error: hold.json?.message || hold.json?.failureReasonMessage || "Official spot hold failed.",
      canBook,
      hold,
    };
  }

  return { ok: true, cookie: hold.cookie || canBook.cookie || cookie, canBook, hold };
}

async function submitUrlEncodedForm(action, body, cookie, referer) {
  let currentUrl = action;
  let currentCookie = cookie || "";
  const redirects = [];
  let response = await fetch(currentUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: currentCookie,
      Origin: BASE_URL,
      Referer: referer,
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });
  currentCookie = mergeCookieHeader(currentCookie, response);

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
        Cookie: currentCookie,
        "User-Agent": "Mozilla/5.0",
      },
    });
    currentCookie = mergeCookieHeader(currentCookie, response);
  }

  return { response, finalUrl: currentUrl, redirects, html, cookie: currentCookie };
}

function analyzeRegistrationPage(html, finalUrl) {
  const text = safeText(html, 4000).toLowerCase();
  const title = pageTitle(html);
  const login = isLoginPage(html, finalUrl);
  const success =
    !login &&
    /(successfully|registered|registration complete|thank you|confirmed)/i.test(text) &&
    !/(checkout|cart|payment|balance due|amount due|add to waitlist)/i.test(text);
  const needsPayment = /(checkout|cart|payment|credit card|balance due|amount due|\$\d)/i.test(text);
  const waitlist = /(waitlist|waiting list|add to waitlist)/i.test(text);

  return {
    title,
    finalUrl,
    success,
    login,
    needsPayment,
    waitlist,
    buttons: extractButtons(html),
    forms: extractForms(html, finalUrl),
    formDetails: extractFormDetails(html, finalUrl),
    links: extractLinks(html, finalUrl),
  };
}

function summarizeRegistrationResult(result) {
  if (!result) return null;
  return {
    title: result.title,
    finalUrl: result.finalUrl,
    success: result.success,
    login: result.login,
    needsPayment: result.needsPayment,
    waitlist: result.waitlist,
    status: result.status,
    redirects: result.redirects,
    looksLoggedIn: result.looksLoggedIn,
    forms: result.forms,
    formDetails: result.formDetails,
  };
}

async function submitOfficialParticipantSelection({
  html,
  pageUrl,
  cookie,
  submission,
  dryRun,
}) {
  if (submission.error) {
    return { submission, preflight: null, result: null };
  }

  let preflight = null;
  let result = null;

  async function saveDebugHtml(label, page) {
    if (!process.env.DEBUG_MARKHAM_HTML_DIR || !page?.html) return;
    const fs = await import("node:fs/promises");
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    await fs.writeFile(
      `${process.env.DEBUG_MARKHAM_HTML_DIR}/markham-${safeLabel}.html`,
      page.html,
      "utf8",
    );
  }

  if (!dryRun) {
    preflight = await prepareOfficialRegistrationHold(
      html,
      pageUrl,
      cookie,
      submission,
    );
    if (!preflight.ok) {
      return { submission, preflight, result: null };
    }

    let submitted = await submitUrlEncodedForm(
      submission.action,
      submission.body,
      preflight.cookie || cookie,
      pageUrl,
    );
    await saveDebugHtml("after-fillforms", submitted);
    result = analyzeRegistrationPage(submitted.html || "", submitted.finalUrl);
    result.status = submitted.response?.status || 0;
    result.redirects = submitted.redirects;
    result.looksLoggedIn = submitted.html
      ? !isLoginPage(submitted.html, submitted.finalUrl)
      : false;

    const extraSteps = [];
    const autoFormIds = ["nextPageForm", "doCheckoutForm"];
    for (let step = 0; step < 5 && !result.success; step += 1) {
      const nextFormId = autoFormIds.find((formId) =>
        extractFormHtml(submitted.html || "", formId),
      );
      if (!nextFormId) break;

      const nextForm = buildFormSubmission(
        submitted.html || "",
        submitted.finalUrl,
        nextFormId,
      );
      if (!nextForm) break;

      let cartPreparation = null;
      if (nextFormId === "doCheckoutForm") {
        cartPreparation = await prepareOnlineStoreCart(
          submitted.html || "",
          submitted.cookie || preflight.cookie || cookie,
          submitted.finalUrl,
        );
        if (!cartPreparation.ok) {
          result.extraSteps = extraSteps;
          result.cartPreparation = cartPreparation;
          break;
        }
        nextForm.body.set("shoppingCartKey", cartPreparation.shoppingCartKey);
      }

      submitted = await submitUrlEncodedForm(
        nextForm.action,
        nextForm.body,
        cartPreparation?.cookie || submitted.cookie || preflight.cookie || cookie,
        submitted.finalUrl,
      );
      await saveDebugHtml(`after-${nextFormId}-${step}`, submitted);
      const nextResult = analyzeRegistrationPage(submitted.html || "", submitted.finalUrl);
      nextResult.status = submitted.response?.status || 0;
      nextResult.redirects = submitted.redirects;
      nextResult.looksLoggedIn = submitted.html
        ? !isLoginPage(submitted.html, submitted.finalUrl)
        : false;
      extraSteps.push({
        formId: nextFormId,
        action: nextForm.action,
        fieldCount: nextForm.fieldCount,
        cartPreparation: cartPreparation
          ? {
              ok: cartPreparation.ok,
              addedItems: cartPreparation.addedItems,
              keyReturned: Boolean(cartPreparation.shoppingCartKey),
              addResults: cartPreparation.addResults,
              keyResult: cartPreparation.keyResult,
            }
          : null,
        result: summarizeRegistrationResult(nextResult),
      });
      result = nextResult;
    }
    result.extraSteps = extraSteps;
  }

  return { submission, preflight, result };
}

async function attendeeForQueuedSession(db, queued, account) {
  const attendeeId = Number(queued.attendee_id || account.default_attendee_id || 0);
  const accountId = Number(account.id);
  const rows = await db`
    select
      id,
      member_id,
      full_name,
      has_free_pass
    from account_attendees
    where account_id = ${accountId}
      and id = ${attendeeId}
    limit 1
  `;
  if (!rows.length) {
    throw new Error("No selected attendee is saved for this queued session.");
  }
  if (!rows[0].has_free_pass) {
    throw new Error(`${rows[0].full_name} does not have a free pass. Automatic registration stopped before payment.`);
  }
  return rows[0];
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
    formDetails: extractFormDetails(html, baseUrl),
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

function safeAjaxResult(result) {
  if (!result) return null;
  return {
    status: result.status,
    ok: result.ok,
    finalUrl: result.finalUrl,
    text: result.text,
    json: result.json,
  };
}

function safePreflight(preflight) {
  if (!preflight) return null;
  return {
    ok: preflight.ok,
    error: preflight.error || "",
    canBook: safeAjaxResult(preflight.canBook),
    hold: safeAjaxResult(preflight.hold),
  };
}

function checkoutRequiredFromResult(result) {
  if (!result) return false;
  return (
    result.needsPayment ||
    /checkout|shoppingcartkey|membercheckout/i.test(result.finalUrl || "") ||
    (result.extraSteps || []).some((step) =>
      /checkout|shoppingcartkey|membercheckout/i.test(
        `${step.action || ""} ${step.result?.finalUrl || ""} ${step.result?.title || ""}`,
      ),
    )
  );
}

function checkoutUrlFromResult(result) {
  if (!result) return "";
  const candidates = [
    result.finalUrl,
    ...(result.extraSteps || []).map((step) => step.result?.finalUrl),
  ].filter(Boolean);
  return candidates.reverse().find((url) => /checkout|shoppingcartkey|membercheckout/i.test(url)) || "";
}

async function markActionRequired(db, queued, checkoutUrl) {
  const token = randomBytes(24).toString("base64url");
  const encrypted = encryptText(checkoutUrl);
  await db`
    update queued_sessions
    set status = 'action_required',
        action_required_at = now(),
        checkout_token = ${token},
        checkout_token_expires_at = now() + interval '25 minutes',
        checkout_url_cipher = ${encrypted.cipher},
        checkout_url_iv = ${encrypted.iv},
        checkout_url_tag = ${encrypted.tag},
        last_attempt_at = now(),
        last_error = 'Checkout needs manual confirmation.',
        updated_at = now()
    where id = ${queued.id}
  `;

  const userCheckoutUrl = publicCheckoutUrl(token);
  const notification = await sendCheckoutNotification(db, queued, userCheckoutUrl);
  return { token, checkoutUrl: userCheckoutUrl, notification };
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
    checkoutUrl:
      row.status === "action_required" && row.checkout_token
        ? `./api/checkout?token=${encodeURIComponent(row.checkout_token)}`
        : "",
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
  const scope = await accountScopeForDevice(db, deviceId);
  const rows = scope.accountIds.length
    ? key
      ? await db`
          select *
          from queued_sessions
          where account_id = any(${scope.accountIds})
            and session_key = ${key}
            and status = 'queued'
          order by
            case when device_id = ${deviceId} then 0 else 1 end,
            updated_at desc
          limit 1
        `
      : await db`
          select *
          from queued_sessions
          where account_id = any(${scope.accountIds})
            and status = 'queued'
          order by
            start_at nulls last,
            created_at
          limit 30
        `
    : key
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

export async function attemptQueuedRegistration(db, queued, options = {}) {
  const dryRun = options.dryRun !== false;
  const queuedAccountId = Number(queued.account_id || 0);
  const accountRows = await db`
    select *
    from account_credentials
    where id = ${queuedAccountId}
       or device_id = ${queued.device_id}
    order by case when id = ${queuedAccountId} then 0 else 1 end
    limit 1
  `;
  if (!accountRows.length) {
    throw new Error("No saved login for this device.");
  }

  const account = accountRows[0];
  const attendee = await attendeeForQueuedSession(db, queued, account);
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
      socialSiteRegisterUrl(registerUrl),
      registerUrl,
    ]);
    const participantProbes = [];
    let officialSubmission = null;
    let officialPreflight = null;
    let officialSubmissionResult = null;

    for (const url of registerCandidates) {
      const socialSiteLogin = /\/SocialSite\//i.test(url)
        ? await verifyPerfectMindLogin(account.email, password, url)
        : null;
      const directPage = await fetchHtmlWithRedirects(
        url,
        socialSiteLogin?.cookie || classPage.cookie || login.cookie,
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
        const formLogin =
          !directHints?.looksLoggedIn
            ? await submitLoginForm(reloggedPage, account.email, password)
            : null;
        const formHints = formLogin?.html
          ? extractRegisterHints(formLogin.html, formLogin.finalUrl)
          : null;
        const participantHtml = formLogin?.html || reloggedPage.html || "";
        const selectionPreview = buildParticipantSelectionPreview(
          participantHtml,
          formLogin?.finalUrl || reloggedPage.finalUrl,
          options.participantIndex,
        );
        const attendeeRecords = await saveAttendees(db, account.id, participantHtml);
        const submission = buildParticipantSelectionSubmission(
          participantHtml,
          formLogin?.finalUrl || reloggedPage.finalUrl,
          attendee,
        );
        if (!officialSubmission && !submission.error) {
          const official = await submitOfficialParticipantSelection({
            html: participantHtml,
            pageUrl: formLogin?.finalUrl || reloggedPage.finalUrl,
            cookie: formLogin?.cookie || reloggedPage.cookie || participantLogin.cookie,
            submission,
            dryRun,
          });
          officialSubmission = official.submission;
          officialPreflight = official.preflight;
          officialSubmissionResult = official.result;
        }
        participantProbes.push({
          url,
          loginFinalUrl: participantLogin.finalUrl || socialSiteLogin?.finalUrl || "",
          loginRedirects: participantLogin.redirects || socialSiteLogin?.redirects || [],
          status: formLogin?.response?.status || reloggedPage.response?.status || 0,
          finalUrl: formLogin?.finalUrl || reloggedPage.finalUrl,
          redirects: formLogin?.redirects || reloggedPage.redirects,
          looksLoggedIn:
            formHints?.looksLoggedIn || directHints?.looksLoggedIn || false,
          hints: formHints || directHints,
          attendeesSaved: attendeeRecords.length,
          selectionPreview,
          submissionPreview: submission.error
            ? submission
            : {
                action: submission.action,
                method: submission.method,
                selectedParticipantIndex: submission.selectedParticipantIndex,
                selectedParticipantLabel: submission.selectedParticipantLabel,
                fieldCount: submission.fieldCount,
              },
          formLogin: formLogin
            ? {
                status: formLogin.response?.status || 0,
                finalUrl: formLogin.finalUrl,
                redirects: formLogin.redirects,
                looksLoggedIn: formHints?.looksLoggedIn || false,
              }
            : null,
        });
        continue;
      }

      const directAttendees = await saveAttendees(db, account.id, directPage.html || "");
      const directSubmission = buildParticipantSelectionSubmission(
        directPage.html || "",
        directPage.finalUrl,
        attendee,
      );
      if (!officialSubmission && !directSubmission.error) {
        const official = await submitOfficialParticipantSelection({
          html: directPage.html || "",
          pageUrl: directPage.finalUrl,
          cookie: directPage.cookie || socialSiteLogin?.cookie || classPage.cookie || login.cookie,
          submission: directSubmission,
          dryRun,
        });
        officialSubmission = official.submission;
        officialPreflight = official.preflight;
        officialSubmissionResult = official.result;
      }
      participantProbes.push({
        url,
        loginFinalUrl: socialSiteLogin?.finalUrl || "",
        loginRedirects: socialSiteLogin?.redirects || [],
        status: directPage.response?.status || 0,
        finalUrl: directPage.finalUrl,
        redirects: directPage.redirects,
        looksLoggedIn: directHints?.looksLoggedIn || false,
        hints: directHints,
        attendeesSaved: directAttendees.length,
        selectionPreview: buildParticipantSelectionPreview(
          directPage.html || "",
          directPage.finalUrl,
          options.participantIndex,
        ),
        submissionPreview: directSubmission.error
          ? directSubmission
          : {
              action: directSubmission.action,
              method: directSubmission.method,
              selectedParticipantIndex: directSubmission.selectedParticipantIndex,
              selectedParticipantLabel: directSubmission.selectedParticipantLabel,
              fieldCount: directSubmission.fieldCount,
            },
        formLogin: null,
      });
    }

    const registrationConfirmed = Boolean(officialSubmissionResult?.success);
    const actionRequired =
      !registrationConfirmed &&
      !dryRun &&
      checkoutRequiredFromResult(officialSubmissionResult);
    const officialCheckoutUrl = actionRequired
      ? checkoutUrlFromResult(officialSubmissionResult)
      : "";
    let actionRequiredResult = null;
    if (registrationConfirmed && !dryRun) {
      await db`
        update queued_sessions
        set status = 'registered',
            registered_at = now(),
            last_attempt_at = now(),
            last_error = '',
            updated_at = now()
        where id = ${queued.id}
      `;
    } else if (actionRequired && officialCheckoutUrl) {
      actionRequiredResult = await markActionRequired(db, queued, officialCheckoutUrl);
    } else if (!dryRun && options.directAttempt) {
      await db`
        update queued_sessions
        set status = 'failed',
            last_attempt_at = now(),
            last_error = 'Direct registration was not confirmed.',
            updated_at = now()
        where id = ${queued.id}
      `;
    }
    const message = registrationConfirmed
      ? "Registration confirmed."
      : actionRequired
        ? "Spot is held. Please complete checkout."
      : dryRun
        ? "Dry-run probe finished. No official registration was submitted."
        : officialPreflight?.error ||
          officialSubmissionResult?.title ||
          "Official flow was submitted, but registration was not confirmed yet.";
    if (!actionRequired) {
      await markAttempt(db, queued.id, message);
    }

    return {
      ok: true,
      dryRun,
      liveRegistrationEnabled: !dryRun,
      message,
      expiredSkipped: options.expired || [],
      queued: sessionSummary(queued),
      attendee: {
        id: attendee.id,
        fullName: attendee.full_name,
        hasFreePass: attendee.has_free_pass,
      },
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
      officialSubmission: officialSubmission
        ? {
            action: officialSubmission.action,
            selectedParticipantIndex: officialSubmission.selectedParticipantIndex,
            selectedParticipantLabel: officialSubmission.selectedParticipantLabel,
            fieldCount: officialSubmission.fieldCount,
          }
        : null,
      officialPreflight: safePreflight(officialPreflight),
      officialSubmissionResult,
      registrationConfirmed,
      actionRequired,
      checkoutUrl: actionRequiredResult?.checkoutUrl || "",
      notification: actionRequiredResult?.notification || null,
    };
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

    const payload = await attemptQueuedRegistration(db, queued, {
      dryRun,
      directAttempt: request.query.direct === "true",
      participantIndex:
        typeof request.query.participantIndex === "string"
          ? request.query.participantIndex
          : "",
      expired: selection.expired,
    });

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(payload);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
