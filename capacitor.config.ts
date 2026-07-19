import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor / Ionic Appflow configuration for Sparkle Insure.
 *
 * The web build output that Capacitor wraps is `dist/`. When wrapping this
 * app for iOS / Android, run:
 *   bun run build
 *   npx cap sync
 *
 * `server.url` (below) can be set to your Lovable-hosted URL to load the
 * live PWA into the native shell (great for Appflow live updates).
 */
const config: CapacitorConfig = {
  appId: "com.sparkleinsure.app",
  appName: "Sparkle Insure",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https",
    // Uncomment and point to your published Lovable URL for OTA-style updates:
    // url: "https://sparkleinsure.lovable.app",
    // cleartext: false,
  },
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
