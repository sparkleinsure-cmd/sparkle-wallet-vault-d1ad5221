(function () {
  var deferredPrompt = null;

  window.sparklePwaInstallReady = false;

  function showInstallButton() {
    var button = document.getElementById("pwa-install-btn");
    if (button) button.style.display = "inline-flex";
  }

  function hideInstallButton() {
    var button = document.getElementById("pwa-install-btn");
    if (button) button.style.display = "none";
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredPrompt = event;
    window.sparklePwaInstallReady = true;
    showInstallButton();
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
    hideInstallButton();
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
        hideInstallButton();
        return choiceResult;
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (window.sparklePwaInstallReady) showInstallButton();
    });
  } else if (window.sparklePwaInstallReady) {
    showInstallButton();
  }
})();
