import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { SplashScreen } from "@capacitor/splash-screen";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Sparkle Insure — Your Modern Financial Wallet" },
      { name: "description", content: "Sparkle Insure is a secure multi-currency digital wallet: deposit, withdraw and manage your money with a premium banking experience." },
      { name: "author", content: "Sparkle Insure" },
      { name: "theme-color", content: "#1B8AA0" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Sparkle Insure" },
      { property: "og:title", content: "Sparkle Insure — Your Modern Financial Wallet" },
      { property: "og:description", content: "Sparkle Insure is a secure multi-currency digital wallet: deposit, withdraw and manage your money with a premium banking experience." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Sparkle Insure — Your Modern Financial Wallet" },
      { name: "twitter:description", content: "Sparkle Insure is a secure multi-currency digital wallet: deposit, withdraw and manage your money with a premium banking experience." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0d3854b8-6216-4684-afcb-21bcbe2eaa51" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0d3854b8-6216-4684-afcb-21bcbe2eaa51" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "apple-touch-icon", href: "/logo.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700;800&display=swap" },
    ],
    scripts: [],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    // Wait for two frames so the in-app splash is visibly painted below the
    // native launch screen. A short, deliberate hold lets its animation play
    // on Android instead of disappearing in the same frame it is mounted.
    let revealTimer: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      void SplashScreen.hide().catch(() => {
        // Browser builds have no native splash plugin.
      });
      window.requestAnimationFrame(() => {
        revealTimer = window.setTimeout(() => setAppReady(true), 1_150);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (revealTimer !== undefined) window.clearTimeout(revealTimer);
    };
  }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppLaunchScreen ready={appReady} />
      <Outlet />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}

function AppLaunchScreen({ ready }: { ready: boolean }) {
  return (
    <div className={`app-launch-screen${ready ? " app-launch-screen--ready" : ""}`} aria-hidden="true">
      <div className="app-launch-screen__glow app-launch-screen__glow--one" />
      <div className="app-launch-screen__glow app-launch-screen__glow--two" />
      <div className="app-launch-screen__content">
        <img className="app-launch-screen__logo" src="/logo.png" alt="" />
        <div className="app-launch-screen__wordmark">Sparkle Insure</div>
        <div className="app-launch-screen__loader"><span /></div>
      </div>
    </div>
  );
}
