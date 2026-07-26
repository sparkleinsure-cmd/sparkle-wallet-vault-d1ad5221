(function () {
  // Chromium supplies this event only after it has confirmed that the current
  // origin meets its PWA installability requirements.
  window.deferredPrompt = null;
  window.sparklePwaInstallReady = false;

  function setInstallButtonVisible(visible) {
    var button = document.getElementById("pwa-install-btn");
    if (button) button.style.display = visible ? "inline-flex" : "none";
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    window.deferredPrompt = event;
    window.sparklePwaInstallReady = true;
    setInstallButtonVisible(true);
    window.dispatchEvent(new Event("sparkle-pwa-install-ready"));
  });

  window.triggerPWAInstall = async function () {
    var promptEvent = window.deferredPrompt;
    if (!promptEvent) return { outcome: "unavailable" };

    // A BeforeInstallPromptEvent may be prompted only once.
    window.deferredPrompt = null;
    window.sparklePwaInstallReady = false;
    setInstallButtonVisible(false);

    try {
      var promptResult = await promptEvent.prompt();
      var choice = promptResult && promptResult.outcome
        ? promptResult
        : await promptEvent.userChoice;
      window.dispatchEvent(
        new CustomEvent("sparkle-pwa-install-choice", { detail: choice }),
      );
      return choice;
    } catch (error) {
      console.warn("PWA install prompt failed", error);
      return { outcome: "unavailable" };
    }
  };

  window.addEventListener("appinstalled", function () {
    window.deferredPrompt = null;
    window.sparklePwaInstallReady = false;
    setInstallButtonVisible(false);
    try {
      window.localStorage.setItem("sparkle_pwa_installed", "true");
    } catch (_) {
      // Storage may be unavailable in private browsing.
    }
    window.dispatchEvent(new Event("sparkle-pwa-installed"));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setInstallButtonVisible(window.sparklePwaInstallReady);
    }, { once: true });
  }
})();
