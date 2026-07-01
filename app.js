if (window.location.protocol === "file:") {
  window.location.href = "http://127.0.0.1:4174/";
}

let sessions = [];
let filteredSessions = [];
let nextKey = null;
let hasMore = true;
let isLoadingMore = false;
let queuedKeys = new Set();
let registeredKeys = new Set();
let sessionStatuses = new Map();
let trackedSessions = [];
let queueApiAvailable = true;

const locationOptions = document.querySelector("#locationOptions");
const serviceOptions = document.querySelector("#serviceOptions");
const locationSummary = document.querySelector("#locationSummary");
const serviceSummary = document.querySelector("#serviceSummary");
const queuedOnlyToggle = document.querySelector("#queuedOnlyToggle");
const registeredOnlyToggle = document.querySelector("#registeredOnlyToggle");
const sessionList = document.querySelector("#sessionList");
const resultCount = document.querySelector("#resultCount");
const loadTrigger = document.querySelector("#loadTrigger");
const template = document.querySelector("#sessionRowTemplate");
const filterPanels = [...document.querySelectorAll(".multi-filter")];
const accountButton = document.querySelector("#accountButton");
const accountDialog = document.querySelector("#accountDialog");
const accountMenu = document.querySelector("#accountMenu");
const accountDropdown = document.querySelector("#accountDropdown");
const accountManage = document.querySelector("#accountManage");
const attendeeMenu = document.querySelector("#attendeeMenu");
const accountLogout = document.querySelector("#accountLogout");
const accountForm = document.querySelector("#accountForm");
const accountClose = document.querySelector("#accountClose");
const accountEmail = document.querySelector("#accountEmail");
const accountPassword = document.querySelector("#accountPassword");
const accountStatus = document.querySelector("#accountStatus");
let accountSaved = false;
let attendees = [];

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
  const onlyQueued = queuedOnlyToggle.checked;
  const onlyRegistered = registeredOnlyToggle.checked;
  const sourceSessions = [...sessions];

  if (onlyQueued || onlyRegistered) {
    const seen = new Set(sourceSessions.map(queuedSessionKey));
    trackedSessions.forEach((session) => {
      const key = queuedSessionKey(session);
      if (seen.has(key)) return;
      seen.add(key);
      sourceSessions.push(session);
    });
  }

  return sourceSessions.filter((session) => {
    const key = queuedSessionKey(session);
    const locationMatch =
      selectedLocations.length === 0 ||
      selectedLocations.includes(session.location);
    const serviceMatch =
      selectedServices.length === 0 || selectedServices.includes(session.service);
    const statusMatch =
      (!onlyQueued && !onlyRegistered) ||
      (onlyQueued && queuedKeys.has(key)) ||
      (onlyRegistered && registeredKeys.has(key));
    return locationMatch && serviceMatch && statusMatch;
  });
}

function statusFilterActive() {
  return queuedOnlyToggle.checked || registeredOnlyToggle.checked;
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
  registeredKeys = new Set();
  sessionStatuses = new Map();
  trackedSessions = [];

  try {
    const params = new URLSearchParams({ deviceId: deviceId() });
    const response = await fetch(`./api/queue?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Queue API failed.");
    const data = await response.json();
    (data.queued || []).forEach((item) => {
      const sessionEndedAt = item.end_at ? new Date(item.end_at) : null;
      const sessionIsPast =
        sessionEndedAt && !Number.isNaN(sessionEndedAt.getTime()) && sessionEndedAt < new Date();
      sessionStatuses.set(item.session_key, item.status);
      if (item.status === "registered") {
        registeredKeys.add(item.session_key);
      } else if (item.status === "queued") {
        queuedKeys.add(item.session_key);
      }
      if (!sessionIsPast && (item.status === "queued" || item.status === "registered")) {
        trackedSessions.push(item.session);
      }
    });
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
  const key = data.key || queuedSessionKey(session);
  queuedKeys.add(key);
  sessionStatuses.set(key, "queued");
  queueApiAvailable = true;
  return { key, status: data.status };
}

async function attemptRegistration(session) {
  const queued = await saveQueuedSession(session);
  const params = new URLSearchParams({
    deviceId: deviceId(),
    key: queued.key,
    dryRun: "false",
  });
  const response = await fetch(`./api/register?${params}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Automatic registration failed.");
  }
  if (!data.registrationConfirmed) {
    throw new Error(data.message || "Registration was not confirmed.");
  }

  registeredKeys.add(queued.key);
  queuedKeys.delete(queued.key);
  sessionStatuses.set(queued.key, "registered");
  return data;
}

async function registerFromRow(session, button) {
  if (button.disabled) return;
  const previousText = button.textContent;
  button.textContent = "Registering...";
  button.disabled = true;

  try {
    await attemptRegistration(session);
    button.textContent = "Registered";
    button.className = "registered";
    button.disabled = true;
  } catch (error) {
    if (error.message.includes("not confirmed")) {
      button.textContent = "Queued";
      button.className = "queued";
      button.disabled = true;
      return;
    }

    button.textContent = "Failed";
    setTimeout(() => {
      button.textContent = previousText;
      button.disabled = false;
    }, 2200);
  }
}

async function runQueueWorker() {
  if (!accountSaved) return;
  try {
    await fetch("./api/queue-worker", { method: "POST", cache: "no-store" });
    await loadQueuedSessions();
    renderSessions();
  } catch {
    // The next interval or page load can try again.
  }
}

function setAccountMessage(message, tone = "") {
  accountStatus.textContent = message;
  accountStatus.dataset.tone = tone;
}

function updateAccountButton(hasAccount, email = "", fullName = "") {
  accountSaved = hasAccount;
  const label = fullName || "My info";
  accountButton.textContent = hasAccount ? label : "Login";
  accountButton.title = email || "Save account";
  accountButton.classList.toggle("saved", hasAccount);
  accountMenu.classList.toggle("saved", hasAccount);
}

function attendeeSubtitle(attendee) {
  if (attendee.hasFreePass) return "Pass";
  if (attendee.priceDisplay) return attendee.priceDisplay;
  if (attendee.isOwner) return "You";
  return "";
}

function renderAttendeeMenu() {
  attendeeMenu.replaceChildren();
  attendeeMenu.hidden = attendees.length === 0;
  if (attendees.length === 0) return;

  const heading = document.createElement("div");
  heading.className = "attendee-menu-heading";
  heading.textContent = "Attendee";
  attendeeMenu.append(heading);

  attendees.forEach((attendee) => {
    const button = document.createElement("button");
    const name = document.createElement("span");
    const meta = document.createElement("small");

    button.type = "button";
    button.className = "attendee-menu-item";
    button.dataset.selected = attendee.isDefault ? "true" : "false";
    name.textContent = attendee.name;
    meta.textContent = attendeeSubtitle(attendee);

    button.append(name, meta);
    button.addEventListener("click", () => selectAttendee(attendee.id));
    attendeeMenu.append(button);
  });
}

async function loadAttendees() {
  if (!accountSaved) {
    attendees = [];
    renderAttendeeMenu();
    return;
  }

  try {
    const params = new URLSearchParams({ deviceId: deviceId() });
    const response = await fetch(`./api/attendees?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Attendee API failed.");
    const data = await response.json();
    attendees = data.attendees || [];
    renderAttendeeMenu();
  } catch {
    attendees = [];
    renderAttendeeMenu();
  }
}

async function selectAttendee(attendeeId) {
  const response = await fetch("./api/attendees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), attendeeId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return;

  attendees = attendees.map((attendee) => ({
    ...attendee,
    isDefault: String(attendee.id) === String(attendeeId),
  }));
  updateAccountButton(true, accountEmail.value, data.displayName);
  renderAttendeeMenu();
  accountDropdown.hidden = true;
}

async function loadAccountStatus() {
  try {
    const params = new URLSearchParams({ deviceId: deviceId() });
    const response = await fetch(`./api/account?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Account API failed.");
    const data = await response.json();

    updateAccountButton(data.hasAccount, data.email, data.displayName || data.fullName);
    accountEmail.value = data.email || "";
    setAccountMessage(
      data.hasAccount ? "Account saved for this device." : "",
      data.hasAccount ? "success" : "",
    );
    loadAttendees();
  } catch {
    updateAccountButton(false);
    attendees = [];
    renderAttendeeMenu();
    setAccountMessage("Account database is not connected.", "error");
  }
}

async function saveAccount(event) {
  event.preventDefault();
  setAccountMessage("Checking City of Markham login...");

  try {
    const response = await fetch("./api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: deviceId(),
        email: accountEmail.value,
        password: accountPassword.value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to save account.");

    accountPassword.value = "";
    updateAccountButton(true, data.email, data.displayName || data.fullName);
    loadAttendees();
    setAccountMessage("Login verified and saved.", "success");
    setTimeout(() => accountDialog.close(), 700);
  } catch (error) {
    setAccountMessage(error.message, "error");
  }
}

async function logoutAccount() {
  accountDropdown.hidden = true;
  setAccountMessage("");

  try {
    await fetch("./api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: deviceId() }),
    });
  } catch {
    // The next explicit login will overwrite the saved account if deletion fails.
  }

  accountEmail.value = "";
  accountPassword.value = "";
  updateAccountButton(false);
  attendees = [];
  renderAttendeeMenu();
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

    row.querySelector(".session-main p").textContent =
      session.timeRange || session.time || "";
    row.querySelector(".session-location").textContent = session.location;
    row.querySelector(".session-action p").textContent = session.spots || "";

    const button = row.querySelector("button");
    const buttonClass = actionClass(session.action);
    const queueKey = queuedSessionKey(session);
    const isRegistered = registeredKeys.has(queueKey);
    const isQueued = queuedKeys.has(queueKey);
    row.dataset.key = queueKey;
    row.dataset.registerable =
      !isRegistered && !isQueued && isRegisterAction(session.action) && session.url
        ? "true"
        : "false";
    button.textContent = isRegistered
      ? "Registered"
      : isRegisterAction(session.action)
      ? "Register"
      : isQueued
        ? "Queued"
        : "Queue";
    button.className = isRegistered ? "registered" : isQueued ? "queued" : buttonClass;
    button.disabled = buttonClass === "full" || isRegistered || isQueued;
    if (!isRegistered && !isQueued && isRegisterAction(session.action) && session.url) {
      serviceLink.href = "#";
      serviceLink.addEventListener("click", (event) => {
        event.preventDefault();
        registerFromRow(session, button);
      });
      button.addEventListener("click", () => registerFromRow(session, button));
    } else if (!isQueued && buttonClass !== "full") {
      serviceLink.href = session.url || "#";
      if (!session.url) serviceLink.removeAttribute("href");
      button.addEventListener("click", async () => {
        const previousText = button.textContent;
        button.textContent = "Saving...";
        button.disabled = true;

        try {
          await saveQueuedSession(session);
          button.textContent = "Queued";
          button.className = "queued";
          button.disabled = true;
        } catch {
          queueApiAvailable = false;
          button.textContent = "Queue failed";
          setTimeout(() => {
            button.textContent = previousText;
            button.disabled = false;
          }, 1800);
        }
      });
    } else {
      serviceLink.href = session.url || "#";
      if (!session.url) serviceLink.removeAttribute("href");
    }

    sessionList.append(row);
  });

  loadTrigger.hidden = statusFilterActive() || (!hasMore && queueApiAvailable);
  loadTrigger.textContent = !queueApiAvailable
    ? "Queue database is not connected."
    : hasMore && !statusFilterActive()
      ? "Loading more..."
      : "";
}

sessionList.addEventListener("click", (event) => {
  const row = event.target.closest(".session-row");
  if (!row || row.dataset.registerable !== "true") return;

  const clickedAction = event.target.closest(".session-action");
  const clickedService = event.target.closest(".session-main");
  if (!clickedAction && !clickedService) return;

  event.preventDefault();
  const session = filteredSessions.find(
    (item) => queuedSessionKey(item) === row.dataset.key,
  );
  const button = row.querySelector(".session-action button");
  if (session && button) registerFromRow(session, button);
});

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
queuedOnlyToggle.addEventListener("change", () => {
  if (queuedOnlyToggle.checked) registeredOnlyToggle.checked = false;
  resetVisibleList();
});
registeredOnlyToggle.addEventListener("change", () => {
  if (registeredOnlyToggle.checked) queuedOnlyToggle.checked = false;
  resetVisibleList();
});

function openAccountDialog() {
  accountDropdown.hidden = true;
  accountDialog.showModal();
  accountEmail.focus();
}

accountButton.addEventListener("click", () => {
  if (!accountSaved) {
    openAccountDialog();
    return;
  }

  accountDropdown.hidden = !accountDropdown.hidden;
});

accountManage.addEventListener("click", () => {
  window.location.href = "https://cityofmarkham.perfectmind.com/Clients/Contact";
});

accountLogout.addEventListener("click", () => {
  logoutAccount();
});

accountClose.addEventListener("click", () => {
  accountDialog.close();
});

accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) accountDialog.close();
});

accountForm.addEventListener("submit", saveAccount);

document.addEventListener("click", (event) => {
  filterPanels.forEach((panel) => {
    if (!panel.contains(event.target)) panel.removeAttribute("open");
  });
  if (!accountMenu.contains(event.target)) accountDropdown.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  filterPanels.forEach((panel) => panel.removeAttribute("open"));
  accountDropdown.hidden = true;
});

async function loadMoreSessions() {
  if (statusFilterActive() || !hasMore || isLoadingMore || !nextKey) return;
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
  if (statusFilterActive() || !hasMore || isLoadingMore) return;

  const scrollPosition = window.scrollY + window.innerHeight;
  const triggerPosition = document.documentElement.scrollHeight - 500;
  if (scrollPosition < triggerPosition) return;

  loadMoreSessions();
}

window.addEventListener("scroll", loadMoreIfNeeded, { passive: true });
window.addEventListener("resize", loadMoreIfNeeded);
setInterval(runQueueWorker, 60000);

loadAccountStatus();
loadSessions();
