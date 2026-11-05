// Offline shell for 院內查藥. The formulary itself is cached by app.js in
// localStorage; this only keeps the page and its scripts available offline.
// __BUILD__ is replaced at build time so every deploy refreshes the cache.
const CACHE = "oe-formulary-__BUILD__";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "formulary.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

// Same-origin GETs: network first (so a new deploy shows up right away), the
// cached copy when offline. Navigations with ?q= / ?text= map to the shell.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.mode !== "navigate") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request, { ignoreSearch: true })
          .then((hit) => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined))
          .then((hit) => hit || Response.error()),
      ),
  );
});
