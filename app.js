if (window.location.protocol === "file:") {
  window.location.href = "http://127.0.0.1:4174/";
}

let sessions = [];
let filteredSessions = [];
let nextKey = null;
let hasMore = true;
let isLoadingMore = false;
let queuedKeys = new Set();
let queueApiAvailable = true;

const locationOptions = document.querySelector("#locationOptions");
const serviceOptions = document.querySelector("#serviceOptions");
const locationSummary = document.querySelector("#locationSummary");
const serviceSummary = document.querySelector("#serviceSummary");
const sessionList = document.querySelector("#sessionList");
const resultCount = document.querySelector("#resultCount");
const loadTrigger = document.querySelector("#loadTrigger");
const template = document.querySelector("#sessionRowTemplate");
const filterPanels = [...document.querySelectorAll(".multi-filter")];

function uniqueValues(key) {
  return [...new Set(sessions.map((session) => session[key]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function selectedValues(container) {
  return [...container.querySelectorAll("input:checked")].map(
    (input) => input.value,
  );
}

function resetFilter(container, values) {
  const previousValues = new Set(selectedValues(container));
  container.replaceChildren();

  values.forEach((value) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");

    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = previousValues.has(value);
    text.textContent = value;

    label.append(checkbox, text);
    container.append(label);
  });
}

function summaryText(values, fallback) {
  if (values.length === 0) return fallback;
  if (values.length === 1) return values[0];
  return `${values.length} selected`;
}

function updateSummaries() {
  locationSummary.textContent = summaryText(
    selectedValues(locationOptions),
    "All locations",
  );
  serviceSummary.textContent = summaryText(
    selectedValues(serviceOptions),
    "All services",
  );
}

function getFilteredSessions() {
  const selectedLocations = selectedValues(locationOptions);
  const selectedServices = selectedValues(serviceOptions);

  return sessions.filter((session) => {
    const locationMatch =
      selectedLocations.length === 0 ||
      selectedLocations.includes(session.location);
    const serviceMatch =
      selectedServices.length === 0 || selectedServices.includes(session.service);
    return locationMatch && serviceMatch;
  });
}

function actionClass(action) {
  const normalized = action.toLowerCase();
  if (normalized.includes("register")) return "";
  if (normalized.includes("full") || normalized.includes("closed")) return "full";
  return "queue";
}

function isRegisterAction(action) {
  return action.toLowerCase().includes("register");
}

function queuedSessionKey(session) {
  return [session.service, session.date, session.timeRange, session.location].join("|");
}

function deviceId() {
  let id = localStorage.getItem("markhamSwimDeviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("markhamSwimDeviceId", id);
  }
  return id;
}

async function loadQueuedSessions() {
  queuedKeys = new Set();

  try {
    const params = new URLSearchParams({ deviceId: deviceId() });
    const response = await fetch(`./api/queue?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Queue API failed.");
    const data = await response.json();
    (data.queued || []).forEach((item) => queuedKeys.add(item.session_key));
    queueApiAvailable = true;
  } catch {
    queueApiAvailable = false;
  }
}

async function saveQueuedSession(session) {
  const response = await fetch("./api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), session }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Queue API failed.");
  }

  const data = await response.json();
  queuedKeys.add(data.key || queuedSessionKey(session));
  queueApiAvailable = true;
}

function renderSessions() {
  filteredSessions = getFilteredSessions();
  let lastDate = "";

  sessionList.replaceChildren();
  resultCount.textContent = `${filteredSessions.length} ${
    filteredSessions.length === 1 ? "session" : "sessions"
  }`;

  if (filteredSessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No swim sessions match these filters.";
    sessionList.append(empty);
    loadTrigger.hidden = true;
    return;
  }

  filteredSessions.forEach((session) => {
    if (session.date && session.date !== lastDate) {
      lastDate = session.date;
      const marker = document.createElement("section");
      marker.className = "date-marker";
      const heading = document.createElement("h2");
      heading.textContent = session.date;
      marker.append(heading);
      sessionList.append(marker);
    }

    const row = template.content.firstElementChild.cloneNode(true);
    const serviceLink = row.querySelector("h2 a");
    serviceLink.textContent = session.service;
    serviceLink.href = session.url || "#";
    if (!session.url) serviceLink.removeAttribute("href");

    row.querySelector(".session-main p").textContent =
      session.timeRange || session.time || "";
    row.querySelector(".session-location").textContent = session.location;
    row.querySelector(".session-action p").textContent = session.spots || "";

    const button = row.querySelector("button");
    const buttonClass = actionClass(session.action);
    const queueKey = queuedSessionKey(session);
    button.textContent = isRegisterAction(session.action)
      ? "Register"
      : queuedKeys.has(queueKey)
        ? "Queued"
        : "Queue";
    button.className = actionClass(session.action);
    button.disabled = buttonClass === "full";
    if (isRegisterAction(session.action) && session.url) {
      button.addEventListener("click", () => {
        window.location.href = session.url;
      });
    } else if (buttonClass !== "full") {
      button.addEventListener("click", async () => {
        const previousText = button.textContent;
        button.textContent = "Saving...";
        button.disabled = true;

        try {
          await saveQueuedSession(session);
          button.textContent = "Queued";
        } catch {
          queueApiAvailable = false;
          button.textContent = "Queue failed";
          setTimeout(() => {
            button.textContent = previousText;
            button.disabled = false;
          }, 1800);
        }
      });
    }

    sessionList.append(row);
  });

  loadTrigger.hidden = !hasMore && queueApiAvailable;
  loadTrigger.textContent = !queueApiAvailable
    ? "Queue database is not connected."
    : hasMore
      ? "Loading more..."
      : "";
}

function refreshFilters() {
  resetFilter(locationOptions, uniqueValues("location"));
  resetFilter(serviceOptions, uniqueValues("service"));
  updateSummaries();
}

function appendUniqueSessions(newSessions) {
  const seen = new Set(
    sessions.map((session) =>
      [session.service, session.date, session.timeRange, session.location].join("|"),
    ),
  );

  newSessions.forEach((session) => {
    const key = [
      session.service,
      session.date,
      session.timeRange,
      session.location,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    sessions.push(session);
  });
}

async function fetchSessionBatch(after) {
  const params = after ? `?after=${encodeURIComponent(after)}` : "";
  const response = await fetch(`./api/classes${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load live sessions.");
  return response.json();
}

async function loadSessions() {
  try {
    await loadQueuedSessions();
    const data = await fetchSessionBatch();
    sessions = data.sessions;
    nextKey = data.nextKey;
    hasMore = data.hasMore;
  } catch (error) {
    sessions = [];
    nextKey = null;
    hasMore = false;
    resultCount.textContent = "Could not load live sessions";
  }

  refreshFilters();
  renderSessions();
}

function resetVisibleList() {
  updateSummaries();
  renderSessions();
  window.scrollTo({ top: 0 });
}

locationOptions.addEventListener("change", resetVisibleList);
serviceOptions.addEventListener("change", resetVisibleList);

document.addEventListener("click", (event) => {
  filterPanels.forEach((panel) => {
    if (!panel.contains(event.target)) panel.removeAttribute("open");
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  filterPanels.forEach((panel) => panel.removeAttribute("open"));
});

async function loadMoreSessions() {
  if (!hasMore || isLoadingMore || !nextKey) return;
  isLoadingMore = true;
  loadTrigger.textContent = "Loading more...";

  try {
    const data = await fetchSessionBatch(nextKey);
    appendUniqueSessions(data.sessions || []);
    nextKey = data.nextKey;
    hasMore = data.hasMore && data.sessions && data.sessions.length > 0;
    refreshFilters();
    renderSessions();
  } catch (error) {
    loadTrigger.textContent = "Could not load more sessions.";
  } finally {
    isLoadingMore = false;
  }
}

function loadMoreIfNeeded() {
  if (!hasMore || isLoadingMore) return;

  const scrollPosition = window.scrollY + window.innerHeight;
  const triggerPosition = document.documentElement.scrollHeight - 500;
  if (scrollPosition < triggerPosition) return;

  loadMoreSessions();
}

window.addEventListener("scroll", loadMoreIfNeeded, { passive: true });
window.addEventListener("resize", loadMoreIfNeeded);

loadSessions();
