/**
 * Lightweight device capability and PWA installation controller.
 *
 * Keep this module dependency-free: it runs before the application bundle so a
 * low-memory Android phone can opt out of expensive presentation work early.
 */

const userAgent = navigator.userAgent || "";
const isAndroid = /Android/i.test(userAgent);
const isAndroidGoBuild = /Go Build/i.test(userAgent);
const memoryGB =
  typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null;
const cpuCores =
  typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : null;

const hasLowMemory = memoryGB !== null && memoryGB <= 2;
const hasLimitedCPU = cpuCores !== null && cpuCores <= 4;

// Restrict the budget classification to Android. A desktop browser can expose
// four logical cores while still having ample power for the full experience.
export const isBudgetDevice =
  isAndroid && (isAndroidGoBuild || hasLowMemory || hasLimitedCPU);

export const deviceCapabilities = Object.freeze({
  isAndroid,
  isAndroidGoBuild,
  isBudgetDevice,
  memoryGB,
  cpuCores,
  // Bundle consumers can use this flag before importing charts, large
  // animation packages, or other optional presentation-only modules.
  shouldLoadHeavyFeatures: !isBudgetDevice,
  shouldUseComplexAnimations: !isBudgetDevice,
  installStrategy: isBudgetDevice ? "native-menu-fallback" : "webapk-prompt",
});

// Also expose a read-only bridge for code that is not bundled as an ES module.
window.sparkleDeviceCapabilities = deviceCapabilities;
window.sparklePwaInstallReady = false;
window.deferredPrompt = null;

function applyDeviceMode() {
  if (isBudgetDevice) document.body.classList.add("low-spec-mode");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyDeviceMode, { once: true });
} else {
  applyDeviceMode();
}

function setInstallButtonVisible(visible) {
  const button = document.getElementById("pwa-install-btn");
  if (button) button.style.display = visible ? "inline-flex" : "none";
}

function removeBudgetInstallHelp() {
  document.getElementById("budget-pwa-install-help")?.remove();
}

/**
 * Android Go and similar devices may fail or delay the remote WebAPK minting
 * stage. This small, dependency-free banner leaves Chrome's native menu as a
 * recovery path instead of retrying expensive application UI.
 */
export function showBudgetInstallHelp() {
  if (document.getElementById("budget-pwa-install-help")) return;

  const banner = document.createElement("aside");
  banner.id = "budget-pwa-install-help";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-modal", "false");
  banner.setAttribute("aria-labelledby", "budget-pwa-install-title");
  banner.innerHTML = `
    <style>
      #budget-pwa-install-help {
        position: fixed;
        inset: auto 12px 12px;
        z-index: 2147483647;
        max-width: 440px;
        margin: auto;
        padding: 18px;
        border: 1px solid rgba(27, 138, 160, .35);
        border-radius: 18px;
        background: #ffffff;
        color: #17363d;
        box-shadow: 0 12px 32px rgba(14, 95, 112, .22);
        font: 14px/1.45 Inter, system-ui, sans-serif;
      }
      #budget-pwa-install-help h2 { margin: 0 32px 8px 0; font-size: 17px; }
      #budget-pwa-install-help ol { margin: 10px 0 0; padding-left: 22px; }
      #budget-pwa-install-help li + li { margin-top: 5px; }
      #budget-pwa-install-help button {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 50%;
        background: #edf7f9;
        color: #0e5f70;
        font-size: 20px;
      }
      @media (prefers-color-scheme: dark) {
        #budget-pwa-install-help {
          border-color: rgba(87, 190, 209, .4);
          background: #102d33;
          color: #f1fbfc;
        }
        #budget-pwa-install-help button { background: #19434c; color: #fff; }
      }
    </style>
    <button type="button" aria-label="Close installation help">×</button>
    <h2 id="budget-pwa-install-title">Install Sparkle from Chrome</h2>
    <p>Your phone can use Chrome's lightweight home-screen installation:</p>
    <ol>
      <li>Tap Chrome's three-dot menu <strong>⋮</strong>.</li>
      <li>Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li>
      <li>Confirm <strong>Add</strong>.</li>
    </ol>
  `;
  banner.querySelector("button")?.addEventListener("click", () => banner.remove());
  document.body.appendChild(banner);
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.deferredPrompt = event;
  window.sparklePwaInstallReady = true;
  setInstallButtonVisible(true);
  window.dispatchEvent(new Event("sparkle-pwa-install-ready"));
});

export async function triggerPWAInstall() {
  const promptEvent = window.deferredPrompt;
  if (!promptEvent) {
    if (isBudgetDevice) window.setTimeout(showBudgetInstallHelp, 2_000);
    return { outcome: "unavailable" };
  }

  // A BeforeInstallPromptEvent can only be used once.
  window.deferredPrompt = null;
  window.sparklePwaInstallReady = false;
  setInstallButtonVisible(false);

  let fallbackTimer;
  if (isBudgetDevice) {
    // Budget hardware sometimes stalls while Chrome contacts the WebAPK
    // minting service. After two seconds, reveal a native-menu escape hatch.
    fallbackTimer = window.setTimeout(showBudgetInstallHelp, 2_000);
  }

  try {
    const promptResult = await promptEvent.prompt();
    const choice =
      promptResult?.outcome ? promptResult : await promptEvent.userChoice;
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    if (choice.outcome === "accepted") removeBudgetInstallHelp();
    if (isBudgetDevice && choice.outcome === "dismissed") {
      showBudgetInstallHelp();
    }
    window.dispatchEvent(
      new CustomEvent("sparkle-pwa-install-choice", { detail: choice }),
    );
    return choice;
  } catch (error) {
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    if (isBudgetDevice) showBudgetInstallHelp();
    console.warn("PWA install prompt failed", error);
    return { outcome: "unavailable" };
  }
}

window.triggerPWAInstall = triggerPWAInstall;

window.addEventListener("appinstalled", () => {
  window.deferredPrompt = null;
  window.sparklePwaInstallReady = false;
  setInstallButtonVisible(false);
  removeBudgetInstallHelp();
  try {
    window.localStorage.setItem("sparkle_pwa_installed", "true");
  } catch {
    // Storage may be unavailable in private browsing.
  }
  window.dispatchEvent(new Event("sparkle-pwa-installed"));
});

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => setInstallButtonVisible(window.sparklePwaInstallReady || isBudgetDevice),
    { once: true },
  );
} else {
  setInstallButtonVisible(window.sparklePwaInstallReady || isBudgetDevice);
}
