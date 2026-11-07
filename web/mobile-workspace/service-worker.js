const CACHE = "sofia-mobile-workspace-v1";
const ASSETS = ["./", "./index.html", "./workspace.css", "./workspace.js", "./manifest.webmanifest", "./sofia-icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/sofia/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put("./index.html", copy)); }
      return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  if (ASSETS.some(asset => url.pathname.endsWith(asset.replace("./", "")))) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});