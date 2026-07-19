import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, setPrimaryCurrency } from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { BalanceCard } from "@/components/BalanceCard";
import { TransactionsTable } from "@/components/TransactionsTable";
import { DepositDialog } from "@/components/DepositDialog";
import { WithdrawDialog } from "@/components/WithdrawDialog";
import { StatementDialog } from "@/components/StatementDialog";
import { CURRENCIES, type Currency, formatMoney, CURRENCY_META } from "@/lib/currency";
import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const fetchMe = getMe;
  const setCcy = setPrimaryCurrency;
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe(),
  });

  const [depOpen, setDepOpen] = useState(false);
  const [wOpen, setWOpen] = useState(false);
  const [sOpen, setSOpen] = useState(false);

  useEffect(() => {
    if (data?.profile && data.profile.kyc_status !== "verified") {
      navigate({ to: "/verify" });
    }
  }, [data, navigate]);

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

        <div className="grid gap-4 md:grid-cols-4">
          {CURRENCIES.map((c) => {
            const w = data.wallets.find((x) => x.currency === c);
            const bal = Number(w?.balance ?? 0);
            return (
              <div key={c} className="glass-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  {CURRENCY_META[c].name}
                </div>
                <div className="mt-1 font-display text-xl font-bold">
                  {formatMoney(bal, c)}
                </div>
              </div>
            );
          })}
        </div>

        <TransactionsTable transactions={data.transactions as any} />
      </main>

      <DepositDialog open={depOpen} onOpenChange={setDepOpen} defaultCurrency={currency} accountId={profile.account_id} userId={profile.id} />
      <WithdrawDialog open={wOpen} onOpenChange={setWOpen} currency={currency} balance={balance} withdrawable={withdrawable} />
      <StatementDialog
        open={sOpen}
        onOpenChange={setSOpen}
        accountId={profile.account_id}
        fullName={`${profile.first_name} ${profile.surname}`}
      />
    </div>
  );
}
