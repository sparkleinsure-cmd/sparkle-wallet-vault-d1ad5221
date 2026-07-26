const CACHE_NAME = "sparkle-insure-v6";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/pwa-register.js",
  "/pwa-install.js",
  "/eruda-loader.js",
  "/pwa-debug.js",
  "/logo.png",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(new Request(url, { cache: "reload" })).catch((error) => {
              console.warn("App-shell resource was not cached", url, error);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
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

  const shouldAlwaysRefresh =
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/pwa-install.js" ||
    url.pathname === "/pwa-register.js" ||
    url.pathname === "/pwa-debug.js" ||
    url.pathname === "/eruda-loader.js" ||
    url.pathname === "/sw.js";

  if (shouldAlwaysRefresh) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) throw new Error(`Navigation failed with ${response.status}`);
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/", copy.clone());
            cache.put("/index.html", copy);
          });
          return response;
        })
        .catch(async () => {
          const cached = await caches.match("/index.html") || await caches.match("/");
          return cached || new Response(
            "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Sparkle Insure</title></head><body><main><h1>You are offline</h1><p>Reconnect to continue using Sparkle Insure.</p></main></body></html>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }),
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
            url.pathname.startsWith("/screenshots/") ||
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
