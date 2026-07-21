(function () {
  var params = new URLSearchParams(window.location.search);
  var debugEnabled = params.get("eruda") === "1" || params.get("debug") === "eruda";
  var resetRequested = params.get("pwa-reset") === "1";

  try {
    debugEnabled = debugEnabled || window.localStorage.getItem("sparkle_eruda_enabled") === "true";
  } catch (_) {
    // Storage can be blocked in private browsing.
  }

  function log(label, value) {
    if (value === undefined) console.info("[Sparkle PWA]", label);
    else console.info("[Sparkle PWA]", label, value);
  }

  function warn(label, value) {
    if (value === undefined) console.warn("[Sparkle PWA]", label);
    else console.warn("[Sparkle PWA]", label, value);
  }

  function compactError(error) {
    if (!error) return error;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (resetRequested) {
    console.info("[Sparkle PWA]", "Reset requested. Clearing caches, service workers, and local PWA flags...");
    Promise.all([
      "caches" in window
        ? caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) { return caches.delete(key); }));
          })
        : Promise.resolve(),
      "serviceWorker" in navigator
        ? navigator.serviceWorker.getRegistrations().then(function (registrations) {
            return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
          })
        : Promise.resolve(),
      Promise.resolve().then(function () {
        try {
          window.localStorage.removeItem("sparkle_pwa_installed");
          window.localStorage.removeItem("sparkle_pwa_install_dismissed_at");
          window.localStorage.setItem("sparkle_eruda_enabled", "true");
        } catch (_) {
          // Storage can be blocked in private browsing.
        }
      }),
    ]).finally(function () {
      var cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("pwa-reset");
      cleanUrl.searchParams.set("eruda", "1");
      window.location.replace(cleanUrl.toString());
    });
    return;
  }

  if (!debugEnabled) return;

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.navigator.standalone === true
    );
  }

  function inspectManifest() {
    var manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) {
      warn("Manifest link missing");
      return Promise.resolve(null);
    }

    var manifestUrl = new URL(manifestLink.getAttribute("href"), window.location.origin).toString();
    log("Manifest link", manifestUrl);

    return fetch(manifestUrl, { cache: "no-store" })
      .then(function (response) {
        log("Manifest fetch", { ok: response.ok, status: response.status, type: response.headers.get("content-type") });
        return response.json();
      })
      .then(function (manifest) {
        log("Manifest summary", {
          name: manifest.name,
          short_name: manifest.short_name,
          id: manifest.id,
          start_url: manifest.start_url,
          scope: manifest.scope,
          display: manifest.display,
          icons: Array.isArray(manifest.icons) ? manifest.icons.length : 0,
          screenshots: Array.isArray(manifest.screenshots) ? manifest.screenshots.length : 0,
        });

        var assets = []
          .concat(Array.isArray(manifest.icons) ? manifest.icons : [])
          .concat(Array.isArray(manifest.screenshots) ? manifest.screenshots : []);

        return Promise.all(
          assets.map(function (asset) {
            var assetUrl = new URL(asset.src, window.location.origin).toString();
            return fetch(assetUrl, { method: "HEAD", cache: "no-store" })
              .then(function (response) {
                log("Manifest asset", {
                  src: asset.src,
                  ok: response.ok,
                  status: response.status,
                  type: response.headers.get("content-type"),
                  sizes: asset.sizes,
                  purpose: asset.purpose,
                });
              })
              .catch(function (error) {
                warn("Manifest asset failed", { src: asset.src, error: compactError(error) });
              });
          }),
        ).then(function () {
          return manifest;
        });
      })
      .catch(function (error) {
        warn("Manifest check failed", compactError(error));
        return null;
      });
  }

  function inspectServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      warn("Service workers not supported");
      return Promise.resolve(null);
    }

    log("Service worker controller", navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : "none yet");

    return navigator.serviceWorker
      .getRegistration("/")
      .then(function (registration) {
        if (!registration) {
          warn("No service worker registration for / yet");
          return null;
        }

        log("Service worker registration", {
          scope: registration.scope,
          active: registration.active ? registration.active.state : null,
          waiting: registration.waiting ? registration.waiting.state : null,
          installing: registration.installing ? registration.installing.state : null,
        });
        return navigator.serviceWorker.ready.then(function (readyRegistration) {
          log("Service worker ready", readyRegistration.scope);
          return readyRegistration;
        });
      })
      .catch(function (error) {
        warn("Service worker check failed", compactError(error));
        return null;
      });
  }

  window.addEventListener("beforeinstallprompt", function () {
    log("beforeinstallprompt fired - native install prompt is available");
  });
  window.addEventListener("sparkle-pwa-install-ready", function () {
    log("sparkle-pwa-install-ready fired - app install button should appear");
  });
  window.addEventListener("sparkle-pwa-installed", function () {
    log("sparkle-pwa-installed fired");
  });
  window.addEventListener("appinstalled", function () {
    log("Browser appinstalled fired");
  });

  window.sparklePwaDebugReport = function () {
    log("Debug report requested");
    log("Environment", {
      href: window.location.href,
      userAgent: window.navigator.userAgent,
      isSecureContext: window.isSecureContext,
      standalone: isStandalone(),
      displayStandalone: window.matchMedia("(display-mode: standalone)").matches,
      serviceWorkerSupported: "serviceWorker" in navigator,
      serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      installReady: Boolean(window.sparklePwaInstallReady),
      installButtonPresent: Boolean(document.getElementById("pwa-install-btn")),
      installButtonDisplay: document.getElementById("pwa-install-btn")?.style.display || null,
    });
    log("Chrome install checklist", {
      https: window.isSecureContext,
      manifest: "checking below",
      serviceWorker: "checking below",
      engagement: "Keep this page open for at least 30 seconds and tap the page once. Chrome may not fire beforeinstallprompt before that.",
      notAlreadyInstalled: "If Sparkle was installed before, uninstall it first or Chrome can suppress the prompt.",
    });

    return Promise.all([inspectManifest(), inspectServiceWorker()]);
  };

  window.sparklePwaDebugReport();

  window.setTimeout(function () {
    if (!window.sparklePwaInstallReady && !isStandalone()) {
      warn("beforeinstallprompt has not fired after 40 seconds. If manifest assets and service worker are OK, Chrome is likely suppressing the prompt because of engagement, previous dismissal, or installed-state history.");
    }
  }, 40_000);
})();
