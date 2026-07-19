import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor / Ionic Appflow configuration for Sparkle Insure.
 *
 * The web build output that Capacitor wraps is `dist/`. When wrapping this
 * app for iOS / Android, run:
 *   bun run build
 *   npx cap sync
 *
 * The app runs from the packaged static build and calls Supabase directly.
 * This keeps Appflow independent of Lovable or a separately hosted web server.
 */
const config: CapacitorConfig = {
  appId: "com.sparkleinsure.app",
  appName: "Sparkle Insure",
  // TanStack SPA mode emits its runnable static files here.
  webDir: "dist/client",
  bundledWebRuntime: false,
  ios: {
    contentInset: "always",
  },
  android: {
    backgroundColor: "#F5F3EE",
  },
  plugins: {
    SplashScreen: {
      // Do not let a failed or stale web bundle trap the user on the native
      // launch screen. The React splash still provides the branded hand-off
      // once the WebView is ready.
      launchAutoHide: true,
      launchFadeOutDuration: 250,
      backgroundColor: "#F5F3EE",
      androidScaleType: "CENTER_INSIDE",
      showSpinner: false,
      splashFullScreen: true,
    },
  },
};

export default config;
