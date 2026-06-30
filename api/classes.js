const BASE_URL = "https://cityofmarkham.perfectmind.com";
const CALENDAR_ID = "39bd5c76-e07f-43f3-af24-c6969091dbb4";
const WIDGET_ID = "6825ea71-e5b7-4c2a-948f-9195507ad90a";
const BOOKING_PATH =
  `/Clients/BookMe4BookingPages/Classes?calendarId=${CALENDAR_ID}` +
  `&widgetId=${WIDGET_ID}&embed=False`;
const BOOKING_URL = `${BASE_URL}${BOOKING_PATH}`;
const CLASSES_URL = `${BASE_URL}/Clients/BookMe4BookingPagesV2/ClassesV2`;
const LOGO_URL =
  "https://content.perfectmind.com/a99974b35d3c4078b8de347eab91319f/" +
  "logo/Markham+Logo+-+CMYK.png";

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

function normalizeClass(item) {
  return {
    eventId: item.EventId || "",
    occurrenceDate: item.OccurrenceDate || "",
    service: item.EventName || "Swimming",
    date: item.FormattedStartDate || "",
    timeRange: item.EventTimeDescription || "",
    location: item.Location || "",
    facility: item.Facility || "",
    spots: item.Spots || "",
    action: item.BookButtonText || item.ClosedButtonName || "More info",
    startDateTime: item.StartDate || item.StartDateTime || item.Start || "",
    endDateTime: item.EndDate || item.EndDateTime || item.End || "",
    url: bookingUrl(item),
  };
}

async function perfectMindFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: BOOKING_URL,
      Origin: BASE_URL,
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`PerfectMind request failed: ${response.status}`);
  }

  const cookie = response.headers.get("set-cookie") || "";
  return { response, cookie };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const after =
      typeof request.query.after === "string" ? request.query.after : "";
    const { response: bookingResponse, cookie } =
      await perfectMindFetch(BOOKING_URL);
    const html = await bookingResponse.text();
    const token = extractToken(html);

    const body = new URLSearchParams({
      calendarId: CALENDAR_ID,
      widgetId: WIDGET_ID,
      page: "0",
      __RequestVerificationToken: token,
    });
    if (after) body.set("after", after);

    const { response: classesResponse } = await perfectMindFetch(CLASSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: cookie,
      },
      body,
    });

    const payload = await classesResponse.json();
    const nextKey = payload.nextKey || "";

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      sessions: (payload.classes || []).map(normalizeClass),
      count: payload.classes?.length || 0,
      nextKey,
      hasMore: Boolean(nextKey && nextKey !== "0001-01-01"),
      logoUrl: LOGO_URL,
      source: BOOKING_URL,
    });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
}
