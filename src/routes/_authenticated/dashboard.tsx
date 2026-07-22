import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccountHealth, getMe, setPrimaryCurrency } from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { BalanceCard } from "@/components/BalanceCard";
import { TransactionsTable } from "@/components/TransactionsTable";
import { DepositDialog } from "@/components/DepositDialog";
import { WithdrawDialog } from "@/components/WithdrawDialog";
import { StatementDialog } from "@/components/StatementDialog";
import { AccountHealthCard } from "@/components/AccountHealthCard";
import { type Currency } from "@/lib/currency";
import { useState } from "react";
import { Gift, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const fetchMe = getMe;
  const fetchHealth = getAccountHealth;
  const setCcy = setPrimaryCurrency;
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe(),
  });
  const { data: health } = useQuery({
    queryKey: ["account-health"],
    queryFn: () => fetchHealth(),
    enabled: !!data?.profile,
  });

  const [depOpen, setDepOpen] = useState(false);
  const [wOpen, setWOpen] = useState(false);
  const [sOpen, setSOpen] = useState(false);

  if (isLoading || !data?.profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const profile = data.profile;
  const currency = (profile.primary_currency as Currency) ?? "ZAR";
  const wallet = data.wallets.find((w) => w.currency === currency);
  const balance = Number(wallet?.balance ?? 0);
  const isAdmin = data.roles.includes("admin");
  const tranches = ((data as any).tranches ?? []) as Array<{ currency: string; remaining: number; maturity_date: string }>;
  const lockedInCurrency = tranches
    .filter((t) => t.currency === currency && new Date(t.maturity_date).getTime() > Date.now())
    .reduce((s, t) => s + Number(t.remaining), 0);
  const withdrawable = Math.max(0, balance - lockedInCurrency);

  return (
    <div className="min-h-screen pb-16">
      <AppHeader isAdmin={isAdmin} accountId={profile.account_id} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6 md:py-10">
        <div>
          <h1 className="font-display text-2xl font-bold md:text-3xl">
            Welcome back, {profile.first_name} 👋
          </h1>
          <p className="text-sm text-muted-foreground">
            Your Sparkle Insure wallet at a glance.
          </p>
        </div>

        <BalanceCard
          zarBalance={Number(data.wallets.find((w) => w.currency === "ZAR")?.balance ?? 0)}
          usdBalance={Number(data.wallets.find((w) => w.currency === "USD")?.balance ?? 0)}
          currency={currency}
          accountId={profile.account_id}
          tranches={(data as any).tranches ?? []}
          onCurrencyChange={async (c) => {
            await setCcy({ data: { currency: c } });
            qc.invalidateQueries({ queryKey: ["me"] });
          }}
          onDeposit={() => setDepOpen(true)}
          onWithdraw={() => setWOpen(true)}
          onStatement={() => setSOpen(true)}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <AccountHealthCard health={health} currentWithdrawable={withdrawable} />
          <div className="glass-card rounded-2xl p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Registered payout details</div>
            {profile.bank_name && profile.bank_account_number ? (
              <>
                <div className="mt-1 font-display text-lg font-bold">{profile.bank_name}</div>
                <div className="text-sm text-muted-foreground">Account •••• {String(profile.bank_account_number).slice(-4)}</div>
                <div className="mt-1 text-sm text-muted-foreground">Cell {profile.phone}</div>
              </>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">Add your bank details in Settings before requesting a withdrawal.</div>
            )}
          </div>
        </div>

        {!profile.welcome_bonus_credited_at && (
          <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-4 sm:flex-row sm:items-center sm:justify-between" role="status">
            <div className="flex gap-3">
              <Gift className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div><div className="font-semibold">Claim your R10 welcome bonus</div><p className="text-sm text-muted-foreground">Update your banking details and take a selfie. Your bonus is added to your growing account after admin approval.</p></div>
            </div>
            <Button asChild className="shrink-0 gradient-brand text-white"><Link to="/settings" hash="verification">Complete setup</Link></Button>
          </div>
        )}

        <TransactionsTable transactions={data.transactions as any} />
      </main>

      <DepositDialog open={depOpen} onOpenChange={setDepOpen} defaultCurrency={currency} accountId={profile.account_id} userId={profile.id} />
      <WithdrawDialog open={wOpen} onOpenChange={setWOpen} currency={currency} balance={balance} withdrawable={withdrawable} bankName={profile.bank_name} accountLast4={profile.bank_account_number ? String(profile.bank_account_number).slice(-4) : null} />
      <StatementDialog
        open={sOpen}
        onOpenChange={setSOpen}
        accountId={profile.account_id}
        fullName={`${profile.first_name} ${profile.surname}`}
      />
    </div>
  );
}
