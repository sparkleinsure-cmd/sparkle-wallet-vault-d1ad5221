(function () {
  var params = new URLSearchParams(window.location.search);
  var enable = params.get("eruda") === "1" || params.get("debug") === "eruda";
  var disable = params.get("eruda") === "0" || params.get("debug") === "off";

  try {
    if (disable) window.localStorage.removeItem("sparkle_eruda_enabled");
    if (enable) window.localStorage.setItem("sparkle_eruda_enabled", "true");
    enable = enable || window.localStorage.getItem("sparkle_eruda_enabled") === "true";
  } catch (_) {
    // Storage can be blocked in private browsing; query-string activation still works.
  }

  if (!enable || window.eruda) return;

  var script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/eruda";
  script.onload = function () {
    if (window.eruda) window.eruda.init();
  };
  document.head.appendChild(script);
})();
