// Keeps the app working offline. Bump the version when files change.
const CACHE = "thought-record-v4";
const FILES = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png",
  "lib/supabase.min.js", "lib/jspdf.umd.min.js", "lib/jspdf.plugin.autotable.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates show up, cache as fallback when offline
self.addEventListener("fetch", (e) => {
  // Only the app's own files; login and records always go straight to the server
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
