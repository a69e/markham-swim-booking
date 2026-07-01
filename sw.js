self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "Markham Swim Booking";
  const options = {
    body: data.body || "A swim booking needs your attention.",
    data: { url: data.url || "/" },
    tag: data.tag || "markham-swim-booking",
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url === url);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    }),
  );
});
