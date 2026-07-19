// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Capacitor and GitHub Pages only serve files. SPA mode creates a static
  // TanStack shell that bootstraps on the device, instead of a hydration-only
  // document that requires the former Cloudflare/TanStack server.
  tanstackStart: {
    spa: {
      enabled: true,
      prerender: {
        outputPath: "/index.html",
      },
    },
  },
  // Edge Functions now provide every protected operation. Do not build the
  // former Cloudflare/Nitro server alongside the native static bundle.
  nitro: false,
  vite: {
    build: {
      outDir: "dist",
    },
  },
});
