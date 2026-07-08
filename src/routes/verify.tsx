import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { sendOtps, verifyOtps } from "@/lib/wallet.functions";
import { Loader2, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/verify")({
  head: () => ({
    meta: [{ title: "Verify your account — Sparkle Insure" }, { name: "robots", content: "noindex" }],
  }),
  component: VerifyPage,
});

function VerifyPage() {
  const navigate = useNavigate();
  const send = useServerFn(sendOtps);
  const verify = useServerFn(verifyOtps);
  const [sent, setSent] = useState<{ delivered: boolean } | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) navigate({ to: "/auth" });
    });
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="glass-card w-full max-w-md rounded-3xl p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl gradient-brand text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold">Verify your email</h1>
            <p className="text-sm text-muted-foreground">Enter the 6-digit code we sent to your email.</p>
          </div>
        </div>

        {!sent ? (
          <Button
            className="w-full gradient-brand text-white"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                const r = await send();
                setSent({ delivered: r.delivered });
                toast.success(
                  r.delivered
                    ? "Verification code sent to your email."
                    : "Code generated. Email delivery is not configured yet — contact support.",
                );
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send verification code
          </Button>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              try {
                await verify({ data: { emailCode } });
                toast.success("Verified! Welcome.");
                navigate({ to: "/dashboard" });
              } catch (err: any) {
                toast.error(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div className="rounded-xl border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              {sent.delivered
                ? "We emailed a 6-digit code to your registered address. Check your inbox (and spam)."
                : "Email delivery isn't configured yet — please contact support to receive your code."}
            </div>
            <div>
              <Label htmlFor="ec">Email verification code</Label>
              <Input id="ec" inputMode="numeric" maxLength={6} required value={emailCode} onChange={(e) => setEmailCode(e.target.value)} />
            </div>
            <Button type="submit" disabled={loading} className="w-full gradient-brand text-white">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Verify & continue
            </Button>
          </form>
        )}

        <button
          type="button"
          className="mt-6 text-center text-xs text-muted-foreground underline"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate({ to: "/auth" });
          }}
        >
          Sign out
        </button>
      </Card>
    </div>
  );
}