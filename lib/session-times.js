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

function parseClock(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (match[3] === "pm" && hour !== 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function markhamOffsetHours(monthIndex) {
  return monthIndex >= 2 && monthIndex <= 10 ? 4 : 5;
}

function markhamDateToIso(year, monthIndex, day, clock) {
  const utcHour = clock.hour + markhamOffsetHours(monthIndex);
  return new Date(Date.UTC(year, monthIndex, day, utcHour, clock.minute)).toISOString();
}

function parseDate(value) {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function inferSessionTimes(session) {
  if (!session) return { startAt: null, endAt: null };
  const start = parseDate(session.startDateTime);
  const end = parseDate(session.endDateTime);
  if (start && end) return { startAt: start.toISOString(), endAt: end.toISOString() };

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

export function sessionHasEnded(row, now = new Date()) {
  const inferred = inferSessionTimes(row?.session || row);
  const endAt = inferred.endAt || row?.end_at || row?.endAt || "";
  return Boolean(endAt && new Date(endAt) < now);
}
