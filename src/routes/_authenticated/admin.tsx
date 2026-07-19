import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/app-api";
import {
  adminLookupUser,
  adminCreditBonus,
  adminSeedDemo,
  adminListPendingDeposits,
  adminGetProofUrl,
  adminVerifyDeposit,
  adminDeclineDeposit,
  adminListPendingWithdrawals,
  adminCompleteWithdrawal,
  adminListActiveTranches,
  adminSetKycStatus,
  adminGetKycProofUrl,
} from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { Loader2, Search, Sparkles, Database, FileDown, CheckCircle2, Bell, XCircle } from "lucide-react";
import jsPDF from "jspdf";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin — Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: AdminPage,
});

function AdminPage() {
  const fetchMe = getMe;
  const lookup = adminLookupUser;
  const credit = adminCreditBonus;
  const seed = adminSeedDemo;
  const listPending = adminListPendingDeposits;
  const getProof = adminGetProofUrl;
  const verifyDep = adminVerifyDeposit;
  const declineDep = adminDeclineDeposit;
  const listWithdrawals = adminListPendingWithdrawals;
  const completeWithdrawal = adminCompleteWithdrawal;
  const listTranches = adminListActiveTranches;
  const setKycStatus = adminSetKycStatus;
  const getKycProof = adminGetKycProofUrl;
  const navigate = useNavigate();

  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe() });
  const { data: pending, refetch: refetchPending } = useQuery({
    queryKey: ["admin-pending-deposits"],
    queryFn: () => listPending(),
    enabled: !!me?.roles.includes("admin"),
  });
  const { data: withdrawals, refetch: refetchWithdrawals } = useQuery({
    queryKey: ["admin-pending-withdrawals"],
    queryFn: () => listWithdrawals(),
    enabled: !!me?.roles.includes("admin"),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (me && !me.roles.includes("admin")) navigate({ to: "/dashboard" });
  }, [me, navigate]);

  const [accountId, setAccountId] = useState("");
  const [target, setTarget] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("ZAR");
  const [note, setNote] = useState("");
  const [holdRule, setHoldRule] = useState<"attach" | "instant">("instant");
  const [parentTrancheId, setParentTrancheId] = useState<string>("");
  const [activeTranches, setActiveTranches] = useState<any[]>([]);

  useEffect(() => {
    if (!target?.profile || holdRule !== "attach") { setActiveTranches([]); return; }
    listTranches({ data: { accountId: target.profile.account_id, currency } })
      .then((r) => setActiveTranches(r.tranches))
      .catch(() => setActiveTranches([]));
  }, [target, currency, holdRule, listTranches]);

  if (isLoading || !me) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="min-h-screen">
      <AppHeader isAdmin accountId={me.profile?.account_id} />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6 md:py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold">Admin Console</h1>
            <p className="text-sm text-muted-foreground">Restricted access · authorized personnel only.</p>
          </div>
          <Button
            variant="outline"
            disabled
            title="Demo seeding is disabled in production"
            onClick={async () => {
              try {
                const r = await seed();
                toast.success(r.seeded ? `Seeded ${r.seeded} demo users` : "Demo data already present");
              } catch (e: any) { toast.error(e.message); }
            }}
          >
            <Database className="mr-2 h-4 w-4" /> Demo seeding disabled
          </Button>
        </div>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-4 flex items-center font-display text-lg font-semibold">
            <Bell className="mr-2 h-4 w-4 text-primary" />
            Withdrawal requests
            {withdrawals?.withdrawals.length ? (
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                {withdrawals.withdrawals.length}
              </span>
            ) : null}
          </h2>
          {!withdrawals?.withdrawals.length ? (
            <p className="text-sm text-muted-foreground">No pending withdrawal requests.</p>
          ) : (
            <div className="space-y-3">
              {withdrawals.withdrawals.map((w: any) => (
                <WithdrawalRow
                  key={w.id}
                  withdrawal={w}
                  onComplete={async (note) => {
                    try {
                      await completeWithdrawal({ data: { txId: w.id, note } });
                      toast.success("Withdrawal marked completed");
                      refetchWithdrawals();
                    } catch (e: any) { toast.error(e.message); }
                  }}
                />
              ))}
            </div>
          )}
        </Card>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-4 font-display text-lg font-semibold">
            Pending deposit verifications
            {pending?.deposits.length ? (
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                {pending.deposits.length}
              </span>
            ) : null}
          </h2>
          {!pending?.deposits.length ? (
            <p className="text-sm text-muted-foreground">No pending deposits.</p>
          ) : (
            <div className="space-y-3">
              {pending.deposits.map((d: any) => (
                <PendingDepositRow
                  key={d.id}
                  deposit={d}
                  onDownload={async () => {
                    if (!d.proof_url) return toast.error("No proof attached");
                    try {
                      const { url } = await getProof({ data: { path: d.proof_url } });
                      window.open(url, "_blank");
                    } catch (e: any) { toast.error(e.message); }
                  }}
                  onVerify={async (correctedAmount: number | undefined, note: string | undefined) => {
                    try {
                      await verifyDep({ data: { txId: d.id, correctedAmount, note } });
                      toast.success("Deposit verified");
                      refetchPending();
                    } catch (e: any) { toast.error(e.message); }
                  }}
                  onDecline={async (reason: string | undefined) => {
                    try {
                      await declineDep({ data: { txId: d.id, reason } });
                      toast.success("Deposit declined & funds cleared");
                      refetchPending();
                    } catch (e: any) { toast.error(e.message); }
                  }}
                />
              ))}
            </div>
          )}
        </Card>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-4 font-display text-lg font-semibold">Lookup by Account ID</h2>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!accountId.trim()) return;
              setLoading(true);
              try {
                const r = await lookup({ data: { accountId: accountId.trim() } });
                setTarget(r);
                if (!r.profile) toast.error("No account with that ID");
              } catch (err: any) { toast.error(err.message); }
              finally { setLoading(false); }
            }}
          >
            <Input
              placeholder="e.g. K7DP2X9M"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
            <Button type="submit" disabled={loading} className="gradient-brand text-white">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </form>
        </Card>

        {target?.profile && (
          <Card className="glass-card space-y-6 rounded-2xl p-6">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Account holder</div>
              <div className="mt-1 font-display text-2xl font-bold">
                {target.profile.first_name} {target.profile.surname}
              </div>
              <div className="text-sm text-muted-foreground">
                {target.profile.email} · {target.profile.phone} · ID {target.profile.account_id}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Identity review: <strong className="uppercase text-foreground">{target.profile.kyc_status}</strong></span>
              {target.profile.proof_url ? <Button size="sm" variant="outline" onClick={async () => {
                try { const { url } = await getKycProof({ data: { path: target.profile.proof_url } }); window.open(url, "_blank", "noopener,noreferrer"); }
                catch (error: any) { toast.error(error.message); }
              }}>Open submission</Button> : null}
              {target.profile.selfie_url ? <Button size="sm" variant="outline" onClick={async () => {
                try { const { url } = await getKycProof({ data: { path: target.profile.selfie_url } }); window.open(url, "_blank", "noopener,noreferrer"); }
                catch (error: any) { toast.error(error.message); }
              }}>Open selfie</Button> : null}
              {target.profile.kyc_status !== "verified" ? <Button size="sm" variant="outline" onClick={async () => {
                try { await setKycStatus({ data: { userId: target.profile.id, status: "verified" } }); toast.success("Identity review approved"); setTarget(await lookup({ data: { accountId: target.profile.account_id } })); }
                catch (error: any) { toast.error(error.message); }
              }}>Approve identity</Button> : null}
              {target.profile.kyc_status !== "rejected" ? <Button size="sm" variant="ghost" onClick={async () => {
                try { await setKycStatus({ data: { userId: target.profile.id, status: "rejected" } }); toast.success("Identity review rejected"); setTarget(await lookup({ data: { accountId: target.profile.account_id } })); }
                catch (error: any) { toast.error(error.message); }
              }}>Reject identity</Button> : null}
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              {CURRENCIES.map((c) => {
                const w = target.wallets.find((x: any) => x.currency === c);
                return (
                  <div key={c} className="rounded-xl border border-border/60 bg-background/40 p-3">
                    <div className="text-[10px] uppercase text-muted-foreground">{CURRENCY_META[c].name}</div>
                    <div className="font-display text-lg font-semibold">{formatMoney(Number(w?.balance ?? 0), c)}</div>
                  </div>
                );
              })}
            </div>

            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const amt = Number(amount);
                if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
                if (holdRule === "attach" && !parentTrancheId) return toast.error("Select an active tranche");
                setLoading(true);
                try {
                  await credit({ data: {
                    accountId: target.profile.account_id,
                    currency, amount: amt,
                    note: note || undefined,
                    holdRule,
                    parentTrancheId: holdRule === "attach" ? parentTrancheId : undefined,
                  } });
                  toast.success(`Credited ${formatMoney(amt, currency)} to ${target.profile.account_id}`);
                  const r = await lookup({ data: { accountId: target.profile.account_id } });
                  setTarget(r);
                  setAmount(""); setNote(""); setParentTrancheId("");
                } catch (err: any) { toast.error(err.message); }
                finally { setLoading(false); }
              }}
            >
            <div className="grid gap-3 md:grid-cols-[1fr_140px]">
              <div>
                <Label>Amount</Label>
                <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Credit Type / Hold Rule</Label>
              <Select value={holdRule} onValueChange={(v) => setHoldRule(v as "attach" | "instant")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="attach">Apply to Active Deposit Tranche</SelectItem>
                  <SelectItem value="instant">Instant Release / Available Funds</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {holdRule === "attach"
                  ? "Bonus inherits the selected tranche's maturity date."
                  : "Bonus is immediately available for withdrawal."}
              </p>
            </div>
            {holdRule === "attach" && (
              <div>
                <Label>Target tranche</Label>
                {activeTranches.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                    No active {currency} tranches for this user.
                  </div>
                ) : (
                  <Select value={parentTrancheId} onValueChange={setParentTrancheId}>
                    <SelectTrigger><SelectValue placeholder="Select a tranche" /></SelectTrigger>
                    <SelectContent>
                      {activeTranches.map((t) => {
                        const days = Math.max(0, Math.ceil((new Date(t.maturity_date).getTime() - Date.now()) / 864e5));
                        return (
                          <SelectItem key={t.id} value={t.id}>
                            {formatMoney(Number(t.amount), t.currency as Currency)} · matures in {days}d ({format(new Date(t.created_at), "d MMM")})
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
              <div>
                <Label>Note</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / description" />
              </div>
              <div>
                <Button type="submit" disabled={loading} className="w-full gradient-accent text-white md:w-auto">
                  <Sparkles className="mr-2 h-4 w-4" /> Credit
                </Button>
              </div>
            </form>
          </Card>
        )}
      </main>
    </div>
  );
}

function parseWithdrawalDescription(desc: string | null | undefined) {
  if (!desc) return { bank: "n/a", account: "n/a" };
  const bank = /Bank:\s*([^·]+?)(?:\s*·|$)/i.exec(desc)?.[1]?.trim() ?? "n/a";
  const account = /Acc:\s*([^·]+?)(?:\s*·|$)/i.exec(desc)?.[1]?.trim() ?? "n/a";
  return { bank, account };
}

function downloadWithdrawalPdf(w: any) {
  const p = w.profiles ?? {};
  const { bank, account } = parseWithdrawalDescription(w.description);
  const doc = new jsPDF();
  doc.setFontSize(18);
  doc.setTextColor(30, 90, 110);
  doc.text("Sparkle Insure — Withdrawal Request", 14, 20);
  doc.setFontSize(11);
  doc.setTextColor(60);
  const lines: [string, string][] = [
    ["Request ID", w.id],
    ["Submitted", format(new Date(w.created_at), "d MMM yyyy HH:mm")],
    ["Status", w.status],
    ["", ""],
    ["Account holder", `${p.first_name ?? ""} ${p.surname ?? ""}`.trim()],
    ["User ID (Account)", p.account_id ?? ""],
    ["Email", p.email ?? ""],
    ["Phone", p.phone ?? ""],
    ["", ""],
    ["Amount", `${w.currency} ${Number(w.amount).toFixed(2)}`],
    ["Bank name", bank],
    ["Account number", account],
  ];
  let y = 34;
  for (const [k, v] of lines) {
    if (k === "" && v === "") { y += 4; continue; }
    doc.setFont("helvetica", "bold");
    doc.text(`${k}:`, 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(v), 70, y);
    y += 7;
  }
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${format(new Date(), "d MMM yyyy HH:mm")} · Sparkle Insure Admin`, 14, 285);
  doc.save(`withdrawal-${p.account_id ?? "user"}-${w.id.slice(0, 8)}.pdf`);
}

function WithdrawalRow({
  withdrawal,
  onComplete,
}: {
  withdrawal: any;
  onComplete: (note: string | undefined) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const p = withdrawal.profiles;
  const { bank, account } = parseWithdrawalDescription(withdrawal.description);
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold">
            {p?.first_name} {p?.surname}{" "}
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{p?.account_id}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {p?.email} · {p?.phone} · {new Date(withdrawal.created_at).toLocaleString()}
          </div>
          <div className="mt-1 font-display text-xl font-bold text-primary">
            {formatMoney(Number(withdrawal.amount), withdrawal.currency as Currency)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Bank: <span className="font-medium text-foreground">{bank}</span> · Acc:{" "}
            <span className="font-mono">{account}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadWithdrawalPdf(withdrawal)}>
          <FileDown className="mr-2 h-4 w-4" /> Download PDF
        </Button>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (e.g. reference paid)" />
        <Button
          size="sm"
          className="gradient-brand text-white"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onComplete(note.trim() || undefined);
            setBusy(false);
          }}
        >
          <CheckCircle2 className="mr-2 h-4 w-4" /> Mark completed
        </Button>
      </div>
    </div>
  );
}

function PendingDepositRow({
  deposit,
  onDownload,
  onVerify,
  onDecline,
}: {
  deposit: any;
  onDownload: () => void;
  onVerify: (correctedAmount: number | undefined, note: string | undefined) => void;
  onDecline: (reason: string | undefined) => void;
}) {
  const [corrected, setCorrected] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const p = deposit.profiles;
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold">
            {p?.first_name} {p?.surname}{" "}
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{p?.account_id}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {p?.email} · Ref {deposit.reference} · {new Date(deposit.created_at).toLocaleString()}
          </div>
          <div className="mt-1 font-display text-xl font-bold text-primary">
            {formatMoney(Number(deposit.amount), deposit.currency as Currency)}
            <span className="ml-2 text-xs font-normal text-muted-foreground">(user-declared)</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onDownload}>
          <FileDown className="mr-2 h-4 w-4" /> Download proof
        </Button>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[160px_1fr_auto]">
        <div>
          <Label className="text-xs">Corrected amount (optional)</Label>
          <Input type="number" step="0.01" min="0" placeholder={String(deposit.amount)} value={corrected} onChange={(e) => setCorrected(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Note / Decline reason</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Receipt shows R450, not R500 · or reason for decline" />
        </div>
        <div className="flex items-end gap-2">
          <Button
            size="sm"
            className="gradient-brand text-white"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const c = corrected.trim() ? Number(corrected) : undefined;
              if (c !== undefined && (!isFinite(c) || c <= 0)) { toast.error("Invalid amount"); setBusy(false); return; }
              await onVerify(c, note.trim() || undefined);
              setBusy(false);
            }}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={declining}
            onClick={async () => {
              if (!confirm("Decline this deposit? The user's wallet credit will be reversed.")) return;
              setDeclining(true);
              await onDecline(note.trim() || undefined);
              setDeclining(false);
            }}
          >
            <XCircle className="mr-2 h-4 w-4" /> Decline
          </Button>
        </div>
      </div>
    </div>
  );
}
