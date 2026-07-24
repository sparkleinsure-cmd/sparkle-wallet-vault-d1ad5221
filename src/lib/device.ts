import { Capacitor } from "@capacitor/core";

export function getSignupDeviceContext() {
  const storageKey = "sparkle-installation-id";
  let installationId = localStorage.getItem(storageKey);
  if (!installationId) {
    installationId = crypto.randomUUID();
    localStorage.setItem(storageKey, installationId);
  }
  const systemFingerprint = [
    Capacitor.getPlatform(),
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
  ].join("|");
  return { installationId, systemFingerprint };
}
