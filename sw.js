// Enkel service worker: hämtar alltid senaste versionen från nätet först,
// och använder sparad kopia bara om mobilen är offline.
const CACHE_PREFIX = "pulse-";
const CACHE = CACHE_PREFIX + "v7";

// Appens grundfiler sparas direkt vid installation, så att den kan öppnas offline.
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "account.js",
  "friends.js",
  "location.js",
  "config.js",
  "manifest.json",
  "vendor/maplibre-gl/maplibre-gl.js",
  "vendor/maplibre-gl/maplibre-gl.css",
  "vendor/supabase/supabase.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  // Kartbilder från OpenFreeMap och anrop till Supabase (andra webbplatser) sparas inte här, bara appens egna filer.
  // Annars skulle cachen växa för varje område du tittar på.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const noStore = /no-store/i.test(response.headers.get("Cache-Control") || "");
        if (response.ok && !noStore) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE)
              .then(cache => cache.put(event.request, copy))
              .catch(() => {})
          );
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
