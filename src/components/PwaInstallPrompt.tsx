import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Smartphone, X } from "lucide-react";
import { Capacitor } from "@capacitor/core";

declare global {
  interface Window {
    deferredPrompt?: Event | null;
    sparkleDeviceCapabilities?: {
      isAndroid: boolean;
      isAndroidGoBuild: boolean;
      isBudgetDevice: boolean;
      memoryGB: number | null;
      cpuCores: number | null;
      shouldLoadHeavyFeatures: boolean;
      shouldUseComplexAnimations: boolean;
      installStrategy: "native-menu-fallback" | "webapk-prompt";
    };
    sparklePwaInstallReady?: boolean;
    triggerPWAInstall?: () => Promise<{ outcome: "accepted" | "dismissed" | "unavailable"; platform?: string }>;
  }
}

const DISMISSED_KEY = "sparkle_pwa_install_dismissed_at";
const INSTALLED_KEY = "sparkle_pwa_installed";
const DISMISS_DAYS = 7;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function recentlyDismissed() {
  const dismissedAt = localStorage.getItem(DISMISSED_KEY);
  if (!dismissedAt) return false;
  return Date.now() - new Date(dismissedAt).getTime() < DISMISS_DAYS * 86_400_000;
}

function isMobileWeb() {
  return /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
}

function isChromeLikeAndroid() {
  const ua = window.navigator.userAgent;
  return /Android/i.test(ua) && /Chrome|CriOS|EdgA/i.test(ua) && !/OPR|Opera|SamsungBrowser|HuaweiBrowser|UCBrowser/i.test(ua);
}

export function PwaInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [iosHint, setIosHint] = useState(false);
  const [manualHint, setManualHint] = useState(false);
  const [globalPromptReady, setGlobalPromptReady] = useState(false);

  useEffect(() => {
    const isIos = /iPhone|iPad|iPod/i.test(window.navigator.userAgent);
    const isAndroid = /Android/i.test(window.navigator.userAgent);
    const isChromeAndroid = isChromeLikeAndroid();
    if (Capacitor.isNativePlatform() || isStandalone() || !isMobileWeb() || recentlyDismissed()) return;

    const onGlobalInstallReady = () => {
      setManualHint(false);
      setIosHint(false);
      setGlobalPromptReady(true);
      setVisible(true);
    };
    const onInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, "true");
      setVisible(false);
    };
    const onInstallUnavailable = () => {
      if (isIos) setIosHint(true);
      else setManualHint(true);
      setVisible(true);
    };

    if (window.sparklePwaInstallReady) onGlobalInstallReady();
    window.addEventListener("sparkle-pwa-install-ready", onGlobalInstallReady);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("sparkle-pwa-installed", onInstalled);
    window.addEventListener("sparkle-pwa-install-unavailable", onInstallUnavailable);

    const fallbackTimer = window.setTimeout(() => {
      if (isIos && !isStandalone()) {
        setIosHint(true);
        setVisible(true);
      } else if (isAndroid && !isChromeAndroid && !window.sparklePwaInstallReady && !isStandalone()) {
        setManualHint(true);
        setVisible(true);
      }
    }, 4_000);

    return () => {
      window.removeEventListener("sparkle-pwa-install-ready", onGlobalInstallReady);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("sparkle-pwa-installed", onInstalled);
      window.removeEventListener("sparkle-pwa-install-unavailable", onInstallUnavailable);
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
    setVisible(false);
  };

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-border bg-background/95 p-4 shadow-2xl backdrop-blur md:bottom-5">
      <button
        type="button"
        aria-label="Hide install prompt"
        onClick={dismiss}
        className="absolute right-2 top-2 rounded-full p-1 text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex gap-3 pr-7">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Smartphone className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="font-display text-sm font-bold">Install Sparkle Insure</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {iosHint
              ? "Tap Share in Safari, then Add to Home Screen to keep Sparkle Insure on your phone."
              : manualHint
                ? "Chrome is not currently offering a true app installation. In Chrome's menu, use Install app only. Add to Home screen may create just a browser shortcut on this phone."
                : "Add Sparkle Insure to your phone for quicker access and an app-like experience. If Chrome does not show the install button yet, keep this page open for 30 seconds and tap once."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {!iosHint && !manualHint && globalPromptReady ? (
          <Button
            className="flex-1 gradient-brand text-white"
            onClick={async () => {
              const choice = window.triggerPWAInstall
                ? await window.triggerPWAInstall()
                : { outcome: "unavailable" as const };
              setGlobalPromptReady(false);
              if (choice.outcome !== "unavailable") setVisible(false);
            }}
          >
            <Download className="mr-2 h-4 w-4" /> Install app
          </Button>
        ) : (
          <Button
            className="flex-1 gradient-brand text-white"
            onClick={() => {
              dismiss();
            }}
          >
            Got it
          </Button>
        )}
        <Button variant="outline" onClick={dismiss}>
          Later
        </Button>
      </div>
    </div>
  );
}
