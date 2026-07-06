import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Sparkles, Wallet, Globe2, Lock, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
        <Link to="/" className="flex items-center gap-3">
          <img src="/logo.png" alt="Sparkle Insure" className="h-10 w-10 rounded-xl object-contain" />
          <span className="font-display text-lg font-bold text-gradient-brand">Sparkle Insure</span>
        </Link>
        <nav className="flex items-center gap-3">
          <Link to="/auth" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
          <Button asChild variant="default" className="gradient-brand text-white shadow-md">
            <Link to="/auth" search={{ mode: "signup" } as any}>
              Get started <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-24 pt-10 md:pt-20">
        <section className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-accent" /> Multi-currency digital wallet
            </div>
            <h1 className="font-display text-5xl font-bold leading-[1.05] md:text-6xl">
              Banking that feels <span className="text-gradient-brand">effortless</span>.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">
              Hold ZAR, NGN, GHS and USD in one insured wallet. Fund via Paystack, withdraw
              in 24 hours, download statements in seconds.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="gradient-brand text-white shadow-lg">
                <Link to="/auth" search={{ mode: "signup" } as any}>Open a wallet</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/auth">I already have an account</Link>
              </Button>
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-6 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Bank-grade encryption</span>
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> KYC verified</span>
              <span className="inline-flex items-center gap-1.5"><Globe2 className="h-3.5 w-3.5" /> Pan-African + USD</span>
            </div>
          </div>

          <div className="relative">
            <div className="glass-card mx-auto max-w-md rounded-3xl p-8">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Sparkle Wallet</span>
                <span>•••• 4821</span>
              </div>
              <div className="mt-6">
                <div className="text-sm text-muted-foreground">Available balance</div>
                <div className="mt-1 font-display text-4xl font-bold">R 128,940.55</div>
              </div>
              <div className="mt-8 grid grid-cols-3 gap-3 text-center text-xs">
                {["Deposit", "Withdraw", "Statement"].map((l) => (
                  <div key={l} className="rounded-xl border border-border/60 bg-background/50 p-3 font-medium">
                    {l}
                  </div>
                ))}
              </div>
              <div className="mt-6 space-y-3">
                {[
                  { l: "Paystack top-up", a: "+R 2,500.00", c: "text-emerald-600" },
                  { l: "Withdrawal", a: "-R 1,200.00", c: "text-rose-600" },
                  { l: "Welcome bonus", a: "+R 500.00", c: "text-emerald-600" },
                ].map((r) => (
                  <div key={r.l} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{r.l}</span>
                    <span className={`font-semibold ${r.c}`}>{r.a}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] gradient-accent opacity-20 blur-3xl" />
          </div>
        </section>

        <section className="mt-28 grid gap-6 md:grid-cols-3">
          {[
            { icon: Wallet, t: "One wallet, four currencies", d: "Hold and spend in ZAR, NGN, GHS and USD without leaving the app." },
            { icon: ShieldCheck, t: "KYC-verified accounts", d: "Every account is verified with dual email + phone OTP for total peace of mind." },
            { icon: Sparkles, t: "Instant deposits with Paystack", d: "Fund your wallet in seconds using cards, bank transfer or mobile money." },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="glass-card rounded-2xl p-6">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl gradient-brand text-white">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="font-display text-lg font-semibold">{t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border/40 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Sparkle Insure. All rights reserved.
      </footer>
    </div>
  );
}
