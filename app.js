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
let actionRequiredKeys = new Set();
let sessionStatuses = new Map();
let sessionAttempts = new Map();
let sessionCheckoutUrls = new Map();
let trackedSessions = [];
let queueApiAvailable = true;
let refreshInFlight = false;
let busyDepth = 0;
const busyControlStates = new WeakMap();
let pullStartY = 0;
let pullDistance = 0;
let pullTracking = false;

const pullRefresh = document.querySelector("#pullRefresh");
const busyOverlay = document.querySelector("#busyOverlay");
const busyLabel = document.querySelector("#busyLabel");
const appShell = document.querySelector(".app-shell");
const locationOptions = document.querySelector("#locationOptions");
const serviceOptions = document.querySelector("#serviceOptions");
const locationSummary = document.querySelector("#locationSummary");
const serviceSummary = document.querySelector("#serviceSummary");
const queuedOnlyToggle = document.querySelector("#queuedOnlyToggle");
const registeredOnlyToggle = document.querySelector("#registeredOnlyToggle");
const checkoutOnlyToggle = document.querySelector("#checkoutOnlyToggle");
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
const notificationsToggle = document.querySelector("#notificationsToggle");
const attendeeMenu = document.querySelector("#attendeeMenu");
const accountLogout = document.querySelector("#accountLogout");
const accountForm = document.querySelector("#accountForm");
const accountClose = document.querySelector("#accountClose");
const accountEmail = document.querySelector("#accountEmail");
const accountPassword = document.querySelector("#accountPassword");
const accountStatus = document.querySelector("#accountStatus");
let accountSaved = false;
let attendees = [];
let notificationsAvailable = false;
let notificationsSubscribed = false;

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
  const onlyCheckout = checkoutOnlyToggle.checked;
  const sourceSessions = [...sessions];

  if (onlyQueued || onlyRegistered || onlyCheckout) {
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
      (!onlyQueued && !onlyRegistered && !onlyCheckout) ||
      (onlyQueued && queuedKeys.has(key)) ||
      (onlyRegistered && registeredKeys.has(key)) ||
      (onlyCheckout && actionRequiredKeys.has(key));
    return locationMatch && serviceMatch && statusMatch;
  });
}

function statusFilterActive() {
  return (
    queuedOnlyToggle.checked ||
    registeredOnlyToggle.checked ||
    checkoutOnlyToggle.checked
  );
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

function sessionOpenAt(session) {
  const start = new Date(session?.startDateTime || "");
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() - 21 * 60 * 60 * 1000);
}

function openingSoonText(session) {
  if (isRegisterAction(session.action)) return "";
  const openAt = sessionOpenAt(session);
  if (!openAt) return "";

  const diff = openAt.getTime() - Date.now();
  if (diff <= 0 || diff > 3 * 60 * 60 * 1000) return "";

  const totalSeconds = Math.ceil(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `open in: ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateCountdownLabels() {
  document.querySelectorAll("[data-open-countdown-key]").forEach((element) => {
    const session = filteredSessions.find(
      (item) => queuedSessionKey(item) === element.dataset.openCountdownKey,
    );
    if (!session) return;
    const text = openingSoonText(session);
    if (text) {
      element.textContent = text;
      element.classList.add("countdown");
    } else {
      element.textContent = session.spots || "";
      element.classList.remove("countdown");
    }
  });
}

function queuedSessionKey(session) {
  return [session.service, session.date, session.timeRange, session.location].join("|");
}

function attemptText(key) {
  const attempt = sessionAttempts.get(key);
  if (!attempt?.lastAttemptAt) return "";

  const date = new Date(attempt.lastAttemptAt);
  if (Number.isNaN(date.getTime())) return `last action: ${attempt.lastAttemptAt}`;

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `last action: ${value("month")} ${value("day")} ${value("hour")}:${value("minute")}`;
}

function fitOneLine(element, maxSize = 10, minSize = 7) {
  element.style.fontSize = `${maxSize}px`;
  element.style.whiteSpace = "nowrap";

  requestAnimationFrame(() => {
    let size = maxSize;
    while (size > minSize && element.scrollWidth > element.clientWidth) {
      size -= 0.5;
      element.style.fontSize = `${size}px`;
    }
  });
}

function statusBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = `status-badge ${className}`;
  badge.textContent = text;
  return badge;
}

function setBusy(active, label = "Syncing...") {
  busyDepth = Math.max(0, busyDepth + (active ? 1 : -1));
  const busy = busyDepth > 0;
  document.body.classList.toggle("is-busy", busy);
  busyOverlay.hidden = !busy;
  if (busy) busyLabel.textContent = label;
  appShell.inert = busy;

  document
    .querySelectorAll("button, input, select, textarea")
    .forEach((control) => {
      if (busy) {
        if (!busyControlStates.has(control)) {
          busyControlStates.set(control, control.disabled);
        }
        control.disabled = true;
      } else if (busyControlStates.has(control)) {
        control.disabled = busyControlStates.get(control);
        busyControlStates.delete(control);
      }
    });
}

async function withBusy(label, task) {
  setBusy(true, label);
  try {
    return await task();
  } finally {
    setBusy(false);
  }
}

["click", "change", "input", "submit", "touchstart", "pointerdown"].forEach((eventName) => {
  document.addEventListener(
    eventName,
    (event) => {
      if (busyDepth <= 0 || event.target.closest(".busy-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
});

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
  actionRequiredKeys = new Set();
  sessionStatuses = new Map();
  sessionAttempts = new Map();
  sessionCheckoutUrls = new Map();
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
      sessionAttempts.set(item.session_key, {
        lastAttemptAt: item.last_attempt_at || "",
        lastError: item.last_error || "",
      });
      if (item.checkout_url) {
        sessionCheckoutUrls.set(item.session_key, item.checkout_url);
      }
      if (item.status === "registered") {
        registeredKeys.add(item.session_key);
      } else if (item.status === "queued") {
        queuedKeys.add(item.session_key);
      } else if (item.status === "action_required") {
        actionRequiredKeys.add(item.session_key);
      }
      if (
        !sessionIsPast &&
        (item.status === "queued" ||
          item.status === "registered" ||
          item.status === "action_required")
      ) {
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
    direct: "true",
  });
  const response = await fetch(`./api/register?${params}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Automatic registration failed.");
  }
  if (data.actionRequired && data.checkoutUrl) {
    queuedKeys.delete(queued.key);
    actionRequiredKeys.add(queued.key);
    sessionStatuses.set(queued.key, "action_required");
    sessionCheckoutUrls.set(queued.key, data.checkoutUrl);
    return data;
  }
  if (!data.registrationConfirmed) {
    throw new Error(data.message || "Registration was not confirmed.");
  }

  registeredKeys.add(queued.key);
  queuedKeys.delete(queued.key);
  actionRequiredKeys.delete(queued.key);
  sessionStatuses.set(queued.key, "registered");
  return data;
}

async function registerFromRow(session, button) {
  if (button.disabled) return;
  const previousText = button.textContent;

  await withBusy("Registering...", async () => {
    button.textContent = "Registering...";
    button.disabled = true;

    try {
      const data = await attemptRegistration(session);
      const key = queuedSessionKey(session);
      if (data.actionRequired && data.checkoutUrl) {
        actionRequiredKeys.add(key);
        queuedKeys.delete(key);
        registeredKeys.delete(key);
        sessionStatuses.set(key, "action_required");
        sessionCheckoutUrls.set(key, data.checkoutUrl);
        await loadQueuedSessions();
        renderSessions();
      } else {
        button.textContent = "Registered";
        button.className = "registered";
        button.disabled = true;
      }
    } catch (error) {
      const key = queuedSessionKey(session);
      queuedKeys.delete(key);
      sessionStatuses.set(key, "failed");
      button.textContent = "Failed";
      await loadQueuedSessions();
      renderSessions();
      setTimeout(() => {
        button.textContent = previousText;
        button.disabled = false;
      }, 2200);
    }
  });
}

async function runQueueWorker({ render = true } = {}) {
  if (!accountSaved) return;
  try {
    await fetch("./api/queue-worker", { method: "POST", cache: "no-store" });
    await loadQueuedSessions();
    if (render) renderSessions();
  } catch {
    // The next interval or page load can try again.
  }
}

async function syncOfficialState() {
  if (!accountSaved) return null;
  const params = new URLSearchParams({ deviceId: deviceId() });
  const response = await fetch(`./api/sync?${params}`, {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
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

function setNotificationButton(message) {
  if (!notificationsToggle) return;
  notificationsToggle.textContent = message;
  notificationsToggle.hidden = !accountSaved;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function loadNotificationStatus() {
  if (!accountSaved || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    notificationsAvailable = false;
    notificationsSubscribed = false;
    setNotificationButton("Enable notifications");
    return;
  }

  try {
    const params = new URLSearchParams({ deviceId: deviceId() });
    const response = await fetch(`./api/push?${params}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    notificationsAvailable = Boolean(data.configured && data.publicKey);
    notificationsSubscribed = Boolean(data.subscribed);
    if (!notificationsAvailable) {
      setNotificationButton("Notifications unavailable");
    } else {
      setNotificationButton(
        notificationsSubscribed ? "Notifications enabled" : "Enable notifications",
      );
    }
  } catch {
    notificationsAvailable = false;
    notificationsSubscribed = false;
    setNotificationButton("Notifications unavailable");
  }
}

async function enableNotifications() {
  if (!accountSaved) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setNotificationButton("Notifications unsupported");
    return;
  }

  setNotificationButton("Enabling...");
  const params = new URLSearchParams({ deviceId: deviceId() });
  const statusResponse = await fetch(`./api/push?${params}`, { cache: "no-store" });
  const status = await statusResponse.json().catch(() => ({}));
  if (!statusResponse.ok || !status.configured || !status.publicKey) {
    setNotificationButton("Notifications unavailable");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setNotificationButton("Notifications blocked");
    return;
  }

  const registration = await navigator.serviceWorker.register("./sw.js");
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(status.publicKey),
    }));

  const response = await fetch("./api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), subscription }),
  });
  if (!response.ok) {
    setNotificationButton("Notifications failed");
    return;
  }

  notificationsSubscribed = true;
  setNotificationButton("Notifications enabled");
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
    loadNotificationStatus();
  } catch {
    updateAccountButton(false);
    attendees = [];
    renderAttendeeMenu();
    setAccountMessage("Account database is not connected.", "error");
    setNotificationButton("Enable notifications");
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
    loadNotificationStatus();
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
  setNotificationButton("Enable notifications");
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
    const spotsLabel = row.querySelector(".session-action p");
    const openingText = openingSoonText(session);
    spotsLabel.textContent = openingText || session.spots || "";
    spotsLabel.classList.toggle("countdown", Boolean(openingText));
    if (openingText) {
      spotsLabel.dataset.openCountdownKey = queuedSessionKey(session);
    }

    const actionPanel = row.querySelector(".session-action");
    const button = row.querySelector("button");
    const buttonClass = actionClass(session.action);
    const queueKey = queuedSessionKey(session);
    const isRegistered = registeredKeys.has(queueKey);
    const isQueued = queuedKeys.has(queueKey);
    const isActionRequired = actionRequiredKeys.has(queueKey);
    const checkoutUrl = sessionCheckoutUrls.get(queueKey);
    row.dataset.key = queueKey;
    row.dataset.registerable =
      !isRegistered && !isQueued && !isActionRequired && isRegisterAction(session.action) && session.url
        ? "true"
        : "false";
    button.textContent = isRegistered
      ? "Registered"
      : isActionRequired
        ? "Checkout"
        : isQueued
          ? "Queued"
          : isRegisterAction(session.action)
            ? "Register"
            : "Queue";
    button.className = isRegistered
      ? "registered"
      : isActionRequired
        ? "action-required"
        : isQueued
          ? "queued"
          : buttonClass;
    button.disabled = (!isActionRequired && buttonClass === "full") || isRegistered || isQueued;
    if (isRegistered) {
      button.replaceWith(statusBadge("Registered", "registered"));
    } else if (isQueued) {
      button.replaceWith(statusBadge("Queued", "queued"));
    } else if (isActionRequired && checkoutUrl) {
      button.addEventListener("click", () => {
        window.location.href = checkoutUrl;
      });
    } else if (!isRegistered && !isQueued && isRegisterAction(session.action) && session.url) {
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

    const attempt = attemptText(queueKey);
    if (attempt && (isQueued || isRegistered || isActionRequired)) {
      const meta = document.createElement("small");
      meta.className = "attempt-meta";
      meta.textContent = attempt;
      actionPanel.append(meta);
      fitOneLine(meta);
    }

    sessionList.append(row);
  });
  updateCountdownLabels();

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

async function refreshAll({ sync = false, reason = "" } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  pullRefresh.textContent = reason === "pull" ? "Refreshing..." : "Syncing...";
  pullRefresh.classList.add("visible");
  setBusy(true, "Syncing...");

  try {
    await loadAccountStatus();
    if (sync) await syncOfficialState();
    if (sync && accountSaved) await runQueueWorker({ render: false });
    await loadSessions();
  } finally {
    refreshInFlight = false;
    setBusy(false);
    pullRefresh.textContent = "Pull to refresh";
    pullRefresh.classList.remove("visible", "ready", "refreshing");
  }
}

function resetVisibleList() {
  updateSummaries();
  renderSessions();
  window.scrollTo({ top: 0 });
}

locationOptions.addEventListener("change", resetVisibleList);
serviceOptions.addEventListener("change", resetVisibleList);
queuedOnlyToggle.addEventListener("change", () => {
  if (queuedOnlyToggle.checked) {
    registeredOnlyToggle.checked = false;
    checkoutOnlyToggle.checked = false;
  }
  resetVisibleList();
});
registeredOnlyToggle.addEventListener("change", () => {
  if (registeredOnlyToggle.checked) {
    queuedOnlyToggle.checked = false;
    checkoutOnlyToggle.checked = false;
  }
  resetVisibleList();
});
checkoutOnlyToggle.addEventListener("change", () => {
  if (checkoutOnlyToggle.checked) {
    queuedOnlyToggle.checked = false;
    registeredOnlyToggle.checked = false;
  }
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

notificationsToggle.addEventListener("click", () => {
  enableNotifications();
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
setInterval(updateCountdownLabels, 1000);

window.addEventListener(
  "touchstart",
  (event) => {
    if (busyDepth > 0 || window.scrollY > 0 || refreshInFlight) return;
    pullStartY = event.touches[0].clientY;
    pullDistance = 0;
    pullTracking = true;
  },
  { passive: true },
);

window.addEventListener(
  "touchmove",
  (event) => {
    if (busyDepth > 0) return;
    if (!pullTracking) return;
    pullDistance = Math.max(0, event.touches[0].clientY - pullStartY);
    if (pullDistance < 18) return;
    pullRefresh.classList.add("visible");
    pullRefresh.classList.toggle("ready", pullDistance > 84);
    pullRefresh.textContent = pullDistance > 84 ? "Release to refresh" : "Pull to refresh";
    document.documentElement.style.setProperty(
      "--pull-distance",
      `${Math.min(pullDistance - 18, 72)}px`,
    );
  },
  { passive: true },
);

window.addEventListener("touchend", () => {
  if (busyDepth > 0) return;
  if (!pullTracking) return;
  const shouldRefresh = pullDistance > 84;
  pullTracking = false;
  pullDistance = 0;
  document.documentElement.style.setProperty("--pull-distance", "0px");
  if (shouldRefresh) refreshAll({ sync: true, reason: "pull" });
});

window.addEventListener("pageshow", () => {
  refreshAll({ sync: true, reason: "open" });
});

window.addEventListener("focus", () => {
  refreshAll({ sync: true, reason: "focus" });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAll({ sync: true, reason: "visible" });
  }
});

refreshAll({ sync: true, reason: "open" });
