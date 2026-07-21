const CACHE_NAME = "sparkle-insure-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/pwa-register.js",
  "/pwa-install.js",
  "/logo.png",
  "/favicon.ico",
  "/icons/icon-192.webp",
  "/icons/icon-512.webp",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/functions/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/", copy.clone());
            cache.put("/index.html", copy);
          });
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (
          response.ok &&
          (url.pathname.startsWith("/assets/") ||
            url.pathname.startsWith("/icons/") ||
            url.pathname === "/manifest.webmanifest" ||
            url.pathname === "/pwa-install.js" ||
            url.pathname === "/pwa-register.js")
        ) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
