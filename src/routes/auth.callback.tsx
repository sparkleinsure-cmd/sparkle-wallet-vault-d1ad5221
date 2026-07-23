import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/auth/callback")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    next: search.next === "reset" ? "reset" as const : "dashboard" as const,
  }),
  component: AuthCallbackPage,
});

function messageFromUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return query.get("error_description") || hash.get("error_description") || query.get("error") || hash.get("error");
}

async function completeEmailLink() {
  const url = new URL(window.location.href);
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const linkError = messageFromUrl();
  if (linkError) throw new Error(linkError);

  const code = query.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
  } else {
    const tokenHash = query.get("token_hash");
    const type = query.get("type");
    if (tokenHash && type) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as "signup" | "recovery" | "email",
      });
      if (error) throw error;
    } else {
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) throw error;
      }
    }
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("This email link is invalid or has expired. Please request a new one.");
}

function AuthCallbackPage() {
  const { next } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      if (active) setError("The email link took too long to complete. Please reopen the latest email or request a new link.");
    }, 15_000);

    void completeEmailLink()
      .then(async () => {
        if (!active) return;
        window.clearTimeout(timeout);
        setConfirmed(true);
        if (next === "reset") {
          await navigate({ to: "/auth", search: { mode: "reset" }, replace: true });
        } else {
          await navigate({ to: "/dashboard", replace: true });
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        window.clearTimeout(timeout);
        setError(reason instanceof Error ? reason.message : "Unable to complete this email link.");
      });

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [navigate, next]);

  return <div className="flex min-h-screen items-center justify-center p-6">
    <Card className="glass-card w-full max-w-md rounded-3xl p-8 text-center">
      {error ? <>
        <AlertCircle className="mx-auto h-10 w-10 text-rose-600" />
        <h1 className="mt-4 font-display text-2xl font-bold">Email link could not be completed</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button asChild className="mt-6 w-full gradient-brand text-white"><Link to="/auth" search={{ mode: "signin" }}>Back to sign in</Link></Button>
      </> : confirmed ? <>
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
        <h1 className="mt-4 font-display text-2xl font-bold">Email confirmed</h1>
        <p className="mt-2 text-sm text-muted-foreground">Taking you securely to your account…</p>
      </> : <>
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
        <h1 className="mt-4 font-display text-2xl font-bold">Completing your email link</h1>
        <p className="mt-2 text-sm text-muted-foreground">Please wait while Sparkle Insure verifies this link.</p>
      </>}
    </Card>
  </div>;
}
