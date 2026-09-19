self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  const data = event.data || {};

  if (data.type === "SHOW_NOTIFICATION") {
    event.waitUntil(
      self.registration.showNotification(
        data.title || "Small Wins System",
        data.options || {}
      )
    );
  }
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil((async () => {
    const target = event.notification?.data?.url;
    const clientsList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of clientsList) {
      if ("focus" in client) {
        await client.focus();
        if (target && "navigate" in client && client.url !== target) {
          try { await client.navigate(target); } catch (_) {}
        }
        return;
      }
    }

    if (target && self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
