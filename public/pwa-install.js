(function () {
  var deferredPrompt = null;

  window.sparklePwaInstallReady = false;

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredPrompt = event;
    window.sparklePwaInstallReady = true;
    window.dispatchEvent(new Event("sparkle-pwa-install-ready"));
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    window.sparklePwaInstallReady = false;
    try {
      window.localStorage.setItem("sparkle_pwa_installed", "true");
    } catch (_) {
      // Storage may be unavailable in private browsing.
    }
    window.dispatchEvent(new Event("sparkle-pwa-installed"));
  });

  window.triggerPWAInstall = function () {
    if (!deferredPrompt) return Promise.resolve({ outcome: "unavailable" });

    return deferredPrompt.prompt().then(function () {
      return deferredPrompt.userChoice.then(function (choiceResult) {
        if (choiceResult.outcome === "accepted") {
          try {
            window.localStorage.setItem("sparkle_pwa_installed", "true");
          } catch (_) {
            // Storage may be unavailable in private browsing.
          }
        }
        deferredPrompt = null;
        window.sparklePwaInstallReady = false;
        return choiceResult;
      });
    });
  };
})();
