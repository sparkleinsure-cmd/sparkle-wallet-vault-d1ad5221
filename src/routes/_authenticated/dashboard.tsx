import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccountHealth, getInsuranceDashboard, getMe, setPrimaryCurrency, submitAccountFreezeDispute } from "@/lib/app-api";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/Header";
import { BalanceCard } from "@/components/BalanceCard";
import { TransactionsTable } from "@/components/TransactionsTable";
import { DepositDialog } from "@/components/DepositDialog";
import { WithdrawDialog } from "@/components/WithdrawDialog";
import { StatementDialog } from "@/components/StatementDialog";
import { AccountHealthCard } from "@/components/AccountHealthCard";
import { ReferFriendCard } from "@/components/ReferFriendCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type Currency } from "@/lib/currency";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, FileText, FileUp, Gift, House, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";

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
    enabled: !!data?.profile && !data.profile.account_frozen,
  });
  const { data: insurance } = useQuery({
    queryKey: ["insurance-dashboard"],
    queryFn: getInsuranceDashboard,
    enabled: !!data?.profile && !data.profile.account_frozen,
  });

  const [depOpen, setDepOpen] = useState(false);
  const [wOpen, setWOpen] = useState(false);
  const [sOpen, setSOpen] = useState(false);
  const [disputePdf, setDisputePdf] = useState<File | null>(null);
  const [disputeStatement, setDisputeStatement] = useState("");
  const [submittingDispute, setSubmittingDispute] = useState(false);

  useEffect(() => {
    const referralCode = localStorage.getItem("sparkle_referral_code");
    if (!referralCode || !data?.profile) return;
    void supabase.rpc("register_my_referral" as any, { p_referral_code: referralCode } as any)
      .then(({ data: registered, error }) => {
        if (registered) localStorage.removeItem("sparkle_referral_code");
        else if (error) console.warn("Referral registration was not completed", error.message);
      });
  }, [data?.profile]);

  if (isLoading || !data?.profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const profile = data.profile;
  const displayName =
    [String(profile.first_name ?? "").trim().split(/\s+/)[0], String(profile.surname ?? "").trim()]
      .filter(Boolean)
      .join(" ") || "Member";
  const isFrozen = profile.account_frozen === true;
  const pendingDispute = (data.accountFreezeDisputes ?? []).find((dispute: any) => dispute.status === "pending");
  const currency = (profile.primary_currency as Currency) ?? "ZAR";
  const wallet = data.wallets.find((w: any) => w.currency === currency);
  const balance = Number(wallet?.balance ?? 0);
  const isAdmin = data.roles.includes("admin");
  const tranches = ((data as any).tranches ?? []) as Array<{ currency: string; remaining: number; maturity_date: string }>;
  const lockedInCurrency = tranches
    .filter((t) => t.currency === currency && new Date(t.maturity_date).getTime() > Date.now())
    .reduce((s, t) => s + Number(t.remaining), 0);
  const withdrawable = Math.max(0, balance - lockedInCurrency);
  const hasInsuranceApplication = Boolean(insurance?.application);
  const insuranceStatus = insurance?.application?.status as "pending" | "approved" | "declined" | undefined;
  const insuranceDescription = insuranceStatus === "pending"
    ? "Your application is under review. Track its progress from your insurance dashboard."
    : insuranceStatus === "approved"
      ? "Manage your insurance credit facility, repayments and claims from your dashboard."
      : insuranceStatus === "declined"
        ? "View your application outcome and manage your next insurance application."
        : "Apply for appliance cover or open your insurance credit dashboard.";

  return (
    <div className="min-h-screen pb-24">
      <AppHeader isAdmin={isAdmin} displayName={displayName} accountId={profile.account_id} />
      <main className="mx-auto max-w-5xl space-y-5 px-3 py-4 sm:px-4 md:px-6 md:py-8">

        {isFrozen && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-5" role="alert">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-bold">Your account is frozen</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Account activity is temporarily blocked while an AML/compliance review is in progress.
                  {profile.freeze_reason ? ` Reason: ${profile.freeze_reason}` : ""}
                </p>
                {pendingDispute ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-background/60 p-4">
                    <div className="font-medium">Your dispute is awaiting admin review</div>
                    <p className="mt-1 text-sm text-muted-foreground">Submitted {new Date(pendingDispute.created_at).toLocaleString()}. You will regain normal account access if the administrator approves it and unfreezes the account.</p>
                  </div>
                ) : (
                  <form
                    className="mt-4 space-y-3 rounded-xl border border-border/60 bg-background/60 p-4"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!disputePdf || disputePdf.type !== "application/pdf") return toast.error("Select a PDF document");
                      if (disputePdf.size > 10 * 1024 * 1024) return toast.error("The PDF must be 10 MB or smaller");
                      if (disputeStatement.trim().length < 10) return toast.error("Please add a written statement of at least 10 characters");
                      setSubmittingDispute(true);
                      const path = `${profile.id}/${crypto.randomUUID()}.pdf`;
                      try {
                        const upload = await supabase.storage.from("account-disputes").upload(path, disputePdf, {
                          contentType: "application/pdf",
                          upsert: false,
                        });
                        if (upload.error) throw new Error(upload.error.message);
                        try {
                          await submitAccountFreezeDispute({ data: { documentPath: path, statement: disputeStatement.trim() } });
                        } catch (error) {
                          await supabase.storage.from("account-disputes").remove([path]);
                          throw error;
                        }
                        toast.success("Your dispute was submitted for review");
                        setDisputePdf(null);
                        setDisputeStatement("");
                        await qc.invalidateQueries({ queryKey: ["me"] });
                      } catch (error: any) {
                        toast.error(error.message);
                      } finally {
                        setSubmittingDispute(false);
                      }
                    }}
                  >
                    <div>
                      <div className="font-medium">Dispute this freeze</div>
                      <p className="text-sm text-muted-foreground">Submit a written explanation and one PDF containing legal or supporting proof that the account owner is not involved in money laundering.</p>
                    </div>
                    <Textarea
                      value={disputeStatement}
                      onChange={(event) => setDisputeStatement(event.target.value)}
                      placeholder="Explain why the freeze should be reviewed…"
                      minLength={10}
                      maxLength={2000}
                    />
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
                        <FileUp className="h-4 w-4" />
                        <span>{disputePdf?.name ?? "Choose PDF evidence"}</span>
                        <input
                          className="sr-only"
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(event) => setDisputePdf(event.target.files?.[0] ?? null)}
                        />
                      </label>
                      <Button type="submit" disabled={submittingDispute}>
                        {submittingDispute && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Submit dispute
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        )}

        {!isFrozen && <>
        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <h1 className="font-display text-xl font-bold">Accounts</h1>
            <span className="text-xs text-muted-foreground">Your portfolio</span>
          </div>
        <BalanceCard
          zarBalance={Number(data.wallets.find((w: any) => w.currency === "ZAR")?.balance ?? 0)}
          usdBalance={Number(data.wallets.find((w: any) => w.currency === "USD")?.balance ?? 0)}
          currency={currency}
          tranches={(data as any).tranches ?? []}
          onCurrencyChange={async (c) => {
            await setCcy({ data: { currency: c } });
            qc.invalidateQueries({ queryKey: ["me"] });
          }}
        />
        </section>

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

        {profile.welcome_bonus_eligible !== false && !(profile.welcome_bonus_claimed_at ?? profile.welcome_bonus_credited_at) && (
          <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-4 sm:flex-row sm:items-center sm:justify-between" role="status">
            <div className="flex gap-3">
              <Gift className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <div className="font-semibold">Claim your R10 welcome bonus</div>
                <p className="text-sm text-muted-foreground">Update your banking details and take a selfie. Your bonus is added to your growing account after admin approval.</p>
                <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                  Helping someone register? Please use the account owner&apos;s own phone and browser. Welcome bonuses are limited per device, so using your phone may make their account appear to have already claimed.
                </p>
              </div>
            </div>
            <Button asChild className="shrink-0 gradient-brand text-white"><Link to="/settings" hash="verification">Complete setup</Link></Button>
          </div>
        )}

        <div className="glass-card rounded-2xl border border-primary/20 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <div className="rounded-xl bg-primary/10 p-3"><ShieldCheck className="h-6 w-6 text-primary" /></div>
              <div><h2 className="font-display text-lg font-bold">{hasInsuranceApplication ? "Manage your Insurance" : "Insure your home appliances"}</h2><p className="text-sm text-muted-foreground">{insuranceDescription}</p></div>
            </div>
            <Button asChild className="shrink-0 gradient-brand text-white"><Link to="/insurance">{hasInsuranceApplication ? "Go to dashboard" : "Open insurance"}</Link></Button>
          </div>
        </div>

        <TransactionsTable transactions={data.transactions as any} />
        <ReferFriendCard accountId={profile.account_id} />
        </>}
      </main>

      {!isFrozen && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/95 px-2 pb-[max(0.5rem,var(--app-safe-bottom))] pt-2 shadow-[0_-8px_30px_-18px_color-mix(in_oklab,var(--foreground)_45%,transparent)] backdrop-blur-xl" aria-label="Account actions">
          <div className="mx-auto grid max-w-xl grid-cols-5 gap-1">
            <Link to="/dashboard" className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-primary" activeProps={{ className: "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-primary/10 text-[10px] font-medium text-primary" }}>
              <House className="h-4 w-4" />
              Home
            </Link>
            <button type="button" onClick={() => setDepOpen(true)} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-foreground hover:bg-muted/70">
              <ArrowDownToLine className="h-4 w-4" />
              Deposit
            </button>
            <button type="button" onClick={() => setWOpen(true)} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-foreground hover:bg-muted/70">
              <ArrowUpFromLine className="h-4 w-4" />
              Withdraw
            </button>
            <button type="button" onClick={() => setSOpen(true)} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-foreground hover:bg-muted/70">
              <FileText className="h-4 w-4" />
              Statement
            </button>
            <Link to="/settings" className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-foreground hover:bg-muted/70">
              <UserRound className="h-4 w-4" />
              Profile
            </Link>
          </div>
        </nav>
      )}

      <DepositDialog open={depOpen} onOpenChange={setDepOpen} defaultCurrency={currency} accountId={profile.account_id} userId={profile.id} />
      <WithdrawDialog open={wOpen} onOpenChange={setWOpen} currency={currency} balance={balance} withdrawable={withdrawable} bankName={profile.bank_name} accountLast4={profile.bank_account_number ? String(profile.bank_account_number).slice(-4) : null} />
      <StatementDialog
        open={sOpen}
        onOpenChange={setSOpen}
        accountId={profile.account_id}
        fullName={`${profile.first_name} ${profile.surname}`}
        phone={profile.phone}
        streetAddress={profile.street_address}
        province={profile.province}
        postalCode={profile.postal_code}
      />
    </div>
  );
}
