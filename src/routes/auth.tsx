import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, Fingerprint } from "lucide-react";
import { biometricIsReady, biometricSignIn } from "@/lib/biometric";
import { Capacitor } from "@capacitor/core";

const authRedirectUrl = () =>
  Capacitor.isNativePlatform()
    ? "com.sparkleinsure.app://auth/confirm"
    : `${window.location.origin}/auth?mode=signin`;

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — Sparkle Insure" },
      { name: "description", content: "Sign in or open a Sparkle Insure wallet in minutes." },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => ({
    mode: (s.mode === "signup" ? "signup" : "signin") as "signup" | "signin",
  }),
  component: AuthPage,
});

const signupSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  surname: z.string().trim().min(1).max(60),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(6).max(30),
  bankName: z.string().trim().min(2).max(100),
  bankAccountNumber: z.string().trim().regex(/^[0-9 -]{4,40}$/, "Enter a valid bank account number"),
  password: z.string().min(8).max(72),
});

function AuthPage() {
  const { mode } = Route.useSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"signin" | "signup">(mode);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <div className="relative hidden overflow-hidden md:block">
        <div className="absolute inset-0 gradient-brand" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.png" alt="" className="h-10 w-10 rounded-xl bg-white/10 p-1" />
            <span className="font-display text-lg font-bold">Sparkle Insure</span>
          </Link>
          <div>
            <h2 className="font-display text-4xl font-bold leading-tight">
              Your money, insured and always in reach.
            </h2>
            <p className="mt-4 max-w-md text-white/80">
              Join thousands using Sparkle Insure to save, spend and move funds across Africa
              with the safety of bank-grade security.
            </p>
          </div>
          <span className="text-xs text-white/60">© {new Date().getFullYear()} Sparkle Insure</span>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <Card className="glass-card w-full max-w-md rounded-3xl p-8">
          <div className="mb-6 flex items-center justify-between">
            <h1 className="font-display text-2xl font-bold">
              {tab === "signin" ? "Welcome back" : "Open your wallet"}
            </h1>
            <div className="flex rounded-full border border-border p-1 text-xs">
              <button
                onClick={() => setTab("signin")}
                className={`rounded-full px-3 py-1 ${tab === "signin" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                Sign in
              </button>
              <button
                onClick={() => setTab("signup")}
                className={`rounded-full px-3 py-1 ${tab === "signup" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                Sign up
              </button>
            </div>
          </div>
          {tab === "signin" ? <SignInForm /> : <SignUpForm />}
          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={async () => {
              const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: authRedirectUrl() },
              });
              if (error) toast.error(error.message);
            }}
          >
            Continue with Google
          </Button>
        </Card>
      </div>
    </div>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  minLength,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  minLength?: number;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        aria-label={show ? "Hide password" : "Show password"}
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-2 my-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function SignInForm() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  useEffect(() => { void biometricIsReady().then(setBiometricReady).catch(() => setBiometricReady(false)); }, []);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        setLoading(false);
        if (error) return toast.error(error.message);
        toast.success("Welcome back!");
        navigate({ to: "/dashboard" });
      }}
    >
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <button
            type="button"
            disabled={resetting}
            className="text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
            onClick={async () => {
              if (!email.trim()) return toast.error("Enter your email above first.");
              setResetting(true);
              const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
                redirectTo: authRedirectUrl(),
              });
              setResetting(false);
              if (error) return toast.error(error.message);
              toast.success("Password reset link sent — check your email.");
            }}
          >
            {resetting ? "Sending…" : "Forgot password?"}
          </button>
        </div>
        <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
      </div>
      <Button type="submit" disabled={loading} className="w-full gradient-brand text-white">
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Sign in
      </Button>
      {biometricReady && <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={async () => { setLoading(true); try { await biometricSignIn(); toast.success("Signed in securely."); navigate({ to: "/dashboard" }); } catch (error: any) { toast.error(error.message ?? "Biometric sign-in was not completed."); } finally { setLoading(false); } }}><Fingerprint className="mr-2 h-4 w-4" /> Sign in with biometrics</Button>}
    </form>
  );
}

function SignUpForm() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    surname: "",
    email: "",
    phone: "",
    bankName: "",
    bankAccountNumber: "",
    password: "",
  });

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const parse = signupSchema.safeParse(form);
        if (!parse.success) return toast.error(parse.error.issues[0].message);
        setLoading(true);
        const { data, error } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            emailRedirectTo: authRedirectUrl(),
            data: {
              first_name: form.firstName,
              surname: form.surname,
              phone: form.phone,
              bank_name: form.bankName,
              bank_account_number: form.bankAccountNumber,
              primary_currency: "ZAR",
            },
          },
        });
        if (error || !data.user) {
          setLoading(false);
          return toast.error(error?.message ?? "Signup failed");
        }

        // With email confirmation enabled Supabase intentionally does not
        // issue a session yet. Never send an unconfirmed user to the identity
        // screen; tell them exactly how to continue instead.
        let session = (await supabase.auth.getSession()).data.session;
        if (!session && !data.session) {
          setLoading(false);
          toast.success("Check your email for the Sparkle verification link. Open it, then sign in to complete your identity review.", { duration: 10_000 });
          navigate({ to: "/auth", search: { mode: "signin" } });
          return;
        }
        setLoading(false);
        toast.success("Account created. You can add verification documents later in Settings before withdrawing.");
        navigate({ to: "/dashboard" });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="fn">First name</Label>
          <Input id="fn" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="sn">Surname</Label>
          <Input id="sn" required value={form.surname} onChange={(e) => setForm({ ...form, surname: e.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="em">Email</Label>
        <Input id="em" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="ph">Phone number</Label>
        <Input id="ph" required placeholder="+27 82 000 0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="bank-name">Registered bank name</Label>
        <Input id="bank-name" required placeholder="e.g. FNB" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="bank-account">Registered bank account number</Label>
        <Input id="bank-account" inputMode="numeric" required placeholder="Your bank account number" value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="pw">Password</Label>
        <PasswordInput
          id="pw"
          minLength={8}
          autoComplete="new-password"
          value={form.password}
          onChange={(v) => setForm({ ...form, password: v })}
        />
      </div>
      <Button type="submit" disabled={loading} className="w-full gradient-brand text-white">
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create account
      </Button>
    </form>
  );
}
