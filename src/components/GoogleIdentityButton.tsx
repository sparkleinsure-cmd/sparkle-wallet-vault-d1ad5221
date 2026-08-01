import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Capacitor } from "@capacitor/core";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

const GOOGLE_CLIENT_ID = "753857194561-4rflg647pbepl3b5vccqjmn2pdolhnb0.apps.googleusercontent.com";
const GOOGLE_SCRIPT_ID = "google-identity-services";

type CredentialResponse = { credential?: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: Record<string, unknown>) => void;
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

async function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...bytes));
  const encoded = new TextEncoder().encode(nonce);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const hashedNonce = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { nonce, hashedNonce };
}

export function GoogleIdentityButton({ mode }: { mode: "signin" | "signup" }) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;

    const render = async () => {
      if (cancelled || !window.google || !containerRef.current) return;
      const { nonce, hashedNonce } = await createNonce();
      if (cancelled || !containerRef.current) return;

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        nonce: hashedNonce,
        use_fedcm_for_prompt: true,
        callback: async (response: CredentialResponse) => {
          if (!response.credential)
            return toast.error("Google did not return a sign-in credential.");
          setLoading(true);
          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google",
            token: response.credential,
            nonce,
          });
          setLoading(false);
          if (error) return toast.error(error.message);
          toast.success(mode === "signup" ? "Your account is ready." : "Signed in with Google.");
          navigate({ to: "/dashboard" });
        },
      });

      const drawButton = () => {
        const element = containerRef.current;
        if (!element || !window.google) return;
        element.replaceChildren();
        window.google.accounts.id.renderButton(element, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: mode === "signup" ? "signup_with" : "signin_with",
          logo_alignment: "left",
          width: Math.floor(element.clientWidth),
        });
      };

      drawButton();
      resizeObserver = new ResizeObserver(drawButton);
      resizeObserver.observe(containerRef.current);
    };

    const existing = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    if (window.google) {
      void render();
    } else if (existing) {
      existing.addEventListener("load", render, { once: true });
      existing.addEventListener("error", () => setScriptFailed(true), { once: true });
    } else {
      const script = document.createElement("script");
      script.id = GOOGLE_SCRIPT_ID;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => void render();
      script.onerror = () => setScriptFailed(true);
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
    };
  }, [mode, navigate]);

  if (Capacitor.isNativePlatform()) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={async () => {
          const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: "com.sparkleinsure.app://auth/confirm?mode=signin" },
          });
          if (error) toast.error(error.message);
        }}
      >
        Continue with Google
      </Button>
    );
  }

  if (scriptFailed) {
    return (
      <p className="text-center text-sm text-destructive">
        Google sign-in could not load. Check your connection and try again.
      </p>
    );
  }

  return (
    <div className="relative min-h-10 w-full">
      <div ref={containerRef} className={loading ? "pointer-events-none opacity-50" : ""} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/70">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
    </div>
  );
}
