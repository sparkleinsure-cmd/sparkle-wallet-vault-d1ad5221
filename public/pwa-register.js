(function () {
  if (!("serviceWorker" in navigator)) return;

  var register = function () {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(function (registration) {
        window.sparkleServiceWorkerReady = true;
        window.dispatchEvent(new CustomEvent("sparkle-service-worker-ready", { detail: registration.scope }));
      })
      .catch(function (error) {
        console.warn("Service worker registration failed", error);
      });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", register, { once: true });
  } else {
    register();
  }
})();
