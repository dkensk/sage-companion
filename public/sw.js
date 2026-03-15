// ── Sage Companion Service Worker ────────────────────────────────────────────
// Handles: offline caching + push notification display

const CACHE_NAME = "sage-v107";
const CACHE_URLS = [
  "/",
  "/elder",
  "/setup",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

// ── Listen for skip-waiting message from client ─────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache what we can; ignore failures (API routes etc.)
      return Promise.allSettled(CACHE_URLS.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first with cache fallback ──────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, API requests, and admin pages — always go to network
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin") || url.pathname.startsWith("/family") || url.pathname.startsWith("/settings")) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        // Cache successful page responses
        if (response.ok && (
          url.pathname === "/" ||
          url.pathname === "/elder" ||
          url.pathname === "/setup" ||
          url.pathname.startsWith("/icons/")
        )) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline fallback: serve from cache
        return caches.match(request).then(cached => {
          if (cached) return cached;
          // Fallback for navigation requests
          if (request.mode === "navigate") return caches.match("/");
          return new Response("Offline", { status: 503 });
        });
      })
  );
});

// ── Push: show medication reminder notification ────────────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "💊 Sage Reminder", body: "Time to take your medication!" };

  try {
    data = event.data.json();
  } catch (e) {}

  const options = {
    body:    data.body  || "Time to take your medication!",
    icon:    data.icon  || "/icons/icon-192.png",
    badge:   data.badge || "/icons/badge-72.png",
    tag:     data.tag   || "sage-reminder",
    vibrate: [200, 100, 200],
    requireInteraction: true,
    actions: [
      { action: "taken",   title: "✅ Mark as Taken" },
      { action: "snooze",  title: "⏰ Remind in 15 min" },
    ],
    data: data.medicationId ? { medicationId: data.medicationId, seniorId: data.seniorId } : {},
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "💊 Sage Reminder", options)
  );
});

// ── Notification click handler ────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const action      = event.action;
  const medData     = event.notification.data || {};
  const medicationId = medData.medicationId;
  const seniorId    = medData.seniorId;

  if (action === "taken" && medicationId && seniorId) {
    // Log medication as taken
    event.waitUntil(
      fetch("/api/medications/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medicationId, seniorId }),
      }).catch(() => {})
    );
  } else if (action === "snooze") {
    // Snooze: just close notification (server will retry next minute check)
    // Could also store snooze in IndexedDB for more sophisticated handling
  } else {
    // Default: open the app
    event.waitUntil(
      clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
        for (const client of clientList) {
          if (client.url.includes("/elder") && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow("/elder");
      })
    );
  }
});

// ── Push subscription change ──────────────────────────────────────────────────
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
    }).then(subscription => {
      return fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription }),
      });
    }).catch(() => {})
  );
});
