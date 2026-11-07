const CACHE = "sofia-mobile-workspace-v2";
// Cache only public, immutable UI assets. Never cache authenticated HTML, login
// callbacks, API responses, screenshots, or user workspace state.
const ASSETS = [
  "./workspace.css",
  "./workspace.js",
  "./login.css",
  "./login.js",
  "./manifest.webmanifest",
  "./sofia-icon.svg",
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname.startsWith("/api/") || url.pathname.startsWith("/workspace/auth/")) return;

  // Protected workspace and login HTML must always be re-authorized by the
  // server. If offline, show a generic non-sensitive error instead of a cached
  // page that could appear to bypass logout or session expiry.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => new Response(
      "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Offline</title><body><main><h1>You are offline</h1><p>Reconnect to sign in to Sofia Workspace.</p></main></body></html>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    )));
    return;
  }

  const asset = ASSETS.find(item => url.pathname === "/workspace/" + item.replace("./", ""));
  if (asset) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
