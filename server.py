from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import unescape
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar
import json
import re


HOST = "127.0.0.1"
PORT = 4174
BASE_URL = "https://cityofmarkham.perfectmind.com"
CALENDAR_ID = "39bd5c76-e07f-43f3-af24-c6969091dbb4"
WIDGET_ID = "6825ea71-e5b7-4c2a-948f-9195507ad90a"
BOOKING_PATH = (
    "/Clients/BookMe4BookingPages/Classes"
    f"?calendarId={CALENDAR_ID}&widgetId={WIDGET_ID}&embed=False"
)
BOOKING_URL = BASE_URL + BOOKING_PATH
CLASSES_URL = BASE_URL + "/Clients/BookMe4BookingPagesV2/ClassesV2"
LOGO_URL = (
    "https://content.perfectmind.com/a99974b35d3c4078b8de347eab91319f/"
    "logo/Markham+Logo+-+CMYK.png"
)


def request(opener, url, data=None):
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": BOOKING_URL,
        "Origin": BASE_URL,
        "X-Requested-With": "XMLHttpRequest",
    }
    body = None
    if data is not None:
        body = urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

    return opener.open(Request(url, data=body, headers=headers), timeout=20).read()


def extract_token(html):
    match = re.search(
        r'name="__RequestVerificationToken"[^>]*value="([^"]+)"',
        html,
    )
    if not match:
        raise RuntimeError("Could not find PerfectMind request token.")
    return unescape(match.group(1))


def booking_url(item):
    if not item.get("EventId") or not item.get("OccurrenceDate"):
        return ""
    return (
        BASE_URL
        + "/Clients/BookMe4LandingPages/Class?"
        + urlencode(
            {
                "widgetId": WIDGET_ID,
                "redirectedFromEmbededMode": "False",
                "classId": item["EventId"],
                "occurrenceDate": item["OccurrenceDate"],
            }
        )
    )


def normalize_class(item):
    date = item.get("FormattedStartDate") or ""
    time = item.get("EventTimeDescription") or ""
    location = item.get("Location") or ""
    facility = item.get("Facility") or ""

    return {
        "service": item.get("EventName") or "Swimming",
        "date": date,
        "timeRange": time,
        "location": location,
        "facility": facility,
        "spots": item.get("Spots") or "",
        "action": item.get("BookButtonText") or item.get("ClosedButtonName") or "More info",
        "url": booking_url(item),
    }


def load_live_sessions(after=None):
    opener = build_opener(HTTPCookieProcessor(CookieJar()))
    html = request(opener, BOOKING_URL).decode("utf-8", errors="replace")
    token = extract_token(html)
    data = {
        "calendarId": CALENDAR_ID,
        "widgetId": WIDGET_ID,
        "page": 0,
        "__RequestVerificationToken": token,
    }
    if after:
        data["after"] = after

    raw = request(opener, CLASSES_URL, data=data)
    payload = json.loads(raw.decode("utf-8"))
    sessions = [normalize_class(item) for item in payload.get("classes", [])]
    next_key = payload.get("nextKey")
    return {
        "sessions": sessions,
        "count": len(sessions),
        "nextKey": next_key,
        "hasMore": bool(next_key and next_key != "0001-01-01"),
        "logoUrl": LOGO_URL,
        "source": BOOKING_URL,
    }


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/classes"):
            try:
                query = parse_qs(urlparse(self.path).query)
                after = query.get("after", [None])[0]
                payload = load_live_sessions(after=after)
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:
                body = json.dumps({"error": str(error)}).encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        super().do_GET()


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    import os

    os.chdir(root)
    print(f"Serving Markham swim page at http://{HOST}:{PORT}/")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
