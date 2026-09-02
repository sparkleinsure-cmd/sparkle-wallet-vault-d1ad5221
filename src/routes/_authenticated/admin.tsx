import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/app-api";
import {
  adminLookupUser,
  adminCreditBonus,
  adminSeedDemo,
  adminListPendingKyc,
  adminListPendingDeposits,
  adminGetProofUrl,
  adminVerifyDeposit,
  adminDeclineDeposit,
  adminListPendingWithdrawals,
  adminCompleteWithdrawal,
  adminListActiveTranches,
  adminSetKycStatus,
  adminGetKycProofUrl,
  adminGetUserCount,
  adminGetWalletOverview,
  adminListUsers,
  adminSetAccountFrozen,
  adminRejectAccountFreezeDispute,
  adminGetAccountDisputeUrl,
  adminDeleteUserAndBanEmail,
  adminListInsuranceApplications,
  adminListInsuranceClaims,
  adminGetInsuranceDocumentUrl,
  adminReviewInsuranceApplication,
  adminReviewInsuranceClaim,
} from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { ArrowLeft, Loader2, Search, Sparkles, Database, FileDown, CheckCircle2, Bell, XCircle, Flag, Trash2, Users, ShieldCheck, ChevronDown, ChevronUp, LockKeyhole, UnlockKeyhole } from "lucide-react";
import jsPDF from "jspdf";
import { format } from "date-fns";

const COMMUNITY_FEATURE_ENABLED = false;

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin — Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: AdminPage,
});

function AdminPage() {
  const fetchMe = getMe;
  const lookup = adminLookupUser;
  const credit = adminCreditBonus;
  const seed = adminSeedDemo;
  const listPendingKyc = adminListPendingKyc;
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
  const { data: pendingKyc, refetch: refetchPendingKyc } = useQuery({
    queryKey: ["admin-pending-kyc"],
    queryFn: () => listPendingKyc(),
    enabled: !!me?.roles.includes("admin"),
    refetchInterval: 30_000,
  });
  const { data: userCount } = useQuery({ queryKey: ["admin-user-count"], queryFn: adminGetUserCount, enabled: !!me?.roles.includes("admin"), refetchInterval: 30_000 });
  const { data: walletOverview, refetch: refetchWalletOverview } = useQuery({ queryKey: ["admin-wallet-overview"], queryFn: adminGetWalletOverview, enabled: !!me?.roles.includes("admin"), refetchInterval: 30_000 });
  const [showUsers, setShowUsers] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const { data: registeredUsers, isFetching: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ["admin-users", userSearch],
    queryFn: () => adminListUsers({ data: { search: userSearch } }),
    enabled: showUsers && !!me?.roles.includes("admin"),
    refetchInterval: 30_000,
  });
  const { data: insuranceApplications, refetch: refetchInsuranceApplications } = useQuery({ queryKey: ["admin-insurance-applications"], queryFn: adminListInsuranceApplications, enabled: !!me?.roles.includes("admin"), refetchInterval: 30_000 });
  const { data: insuranceClaims, refetch: refetchInsuranceClaims } = useQuery({ queryKey: ["admin-insurance-claims"], queryFn: adminListInsuranceClaims, enabled: !!me?.roles.includes("admin"), refetchInterval: 30_000 });
  const { data: withdrawals, refetch: refetchWithdrawals } = useQuery({
    queryKey: ["admin-pending-withdrawals"],
    queryFn: () => listWithdrawals(),
    enabled: !!me?.roles.includes("admin"),
    refetchInterval: 30_000,
  });
  const { data: communityReports, refetch: refetchCommunityReports } = useQuery({
    queryKey: ["admin-community-reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("community_reports" as any)
        .select("*, community_messages(id, body, image_path, account_id, author_name, created_at)")
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: COMMUNITY_FEATURE_ENABLED && !!me?.roles.includes("admin"),
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
      <AppHeader isAdmin />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6 md:py-10">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate({ to: "/dashboard" })}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
        </Button>
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

        <Card
          className="glass-card flex cursor-pointer flex-wrap items-center gap-3 rounded-2xl p-5 transition-colors hover:border-primary/40"
          role="button"
          tabIndex={0}
          aria-expanded={showUsers}
          onClick={() => setShowUsers((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setShowUsers((value) => !value);
            }
          }}
        >
          <div className="rounded-full bg-primary/15 p-3"><Users className="h-5 w-5 text-primary" /></div>
          <div className="min-w-32 flex-1">
            <div className="text-sm text-muted-foreground">Total registered users</div>
            <div className="font-display text-3xl font-bold">{userCount?.count ?? "—"}</div>
            <div className="mt-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              ({userCount?.onlineCount ?? 0} {(userCount?.onlineCount ?? 0) === 1 ? "user" : "users"} online)
            </div>
          </div>
          <div className="min-w-[calc(50%-0.375rem)] flex-1 rounded-xl border border-border/60 bg-background/50 px-3 py-2 sm:min-w-32 sm:flex-none"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total withdrawable</div><div className="mt-1 text-sm font-semibold">{formatBalanceValues(walletOverview?.totals?.withdrawable)}</div></div>
          <div className="min-w-[calc(50%-0.375rem)] flex-1 rounded-xl border border-border/60 bg-background/50 px-3 py-2 sm:min-w-32 sm:flex-none"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total growing</div><div className="mt-1 text-sm font-semibold">{formatBalanceValues(walletOverview?.totals?.growing)}</div></div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            {showUsers ? "Hide users" : "View users"}
            {showUsers ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
          </div>
        </Card>

        {showUsers && (
          <Card className="glass-card rounded-2xl p-6">
            <div className="mb-4">
              <h2 className="font-display text-lg font-semibold">Registered users</h2>
              <p className="text-sm text-muted-foreground">Search by name, phone, email, account ID, or User ID.</p>
            </div>
            <div className="relative mb-4">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search registered users…" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} />
            </div>
            {usersLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : !registeredUsers?.users.length ? (
              <p className="py-4 text-sm text-muted-foreground">No registered users match this search.</p>
            ) : (
              <div className="space-y-3">
                {registeredUsers.users.map((user) => (
                  <RegisteredUserRow key={user.id} user={user} metrics={walletOverview?.metricsByUser?.[user.id]} onChanged={() => { refetchUsers(); refetchWalletOverview(); }} />
                ))}
              </div>
            )}
          </Card>
        )}

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-1 flex items-center font-display text-lg font-semibold"><ShieldCheck className="mr-2 h-5 w-5 text-primary" />Appliance insurance applications
            {!!insuranceApplications?.applications?.length && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">{insuranceApplications.applications.length}</span>}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">Review supporting documents and allocate an approved credit facility.</p>
          {!insuranceApplications?.applications?.length ? <p className="text-sm text-muted-foreground">No insurance applications are waiting for review.</p> :
            <div className="space-y-3">{insuranceApplications.applications.map((application:any)=><InsuranceApplicationRow key={application.id} application={application} openDocument={async(path)=>{try{const {url}=await adminGetInsuranceDocumentUrl({data:{path}});window.open(url,"_blank","noopener,noreferrer");}catch(error:any){toast.error(error.message)}}} onDone={()=>refetchInsuranceApplications()}/>)}</div>}
        </Card>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-1 flex items-center font-display text-lg font-semibold"><ShieldCheck className="mr-2 h-5 w-5 text-primary" />Insurance claims
            {!!insuranceClaims?.claims?.length && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">{insuranceClaims.claims.length}</span>}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">Approve a claim to credit the amount into the user’s withdrawable ZAR wallet balance.</p>
          {!insuranceClaims?.claims?.length ? <p className="text-sm text-muted-foreground">No insurance claims are waiting for review.</p> :
            <div className="space-y-3">{insuranceClaims.claims.map((claim:any)=><InsuranceClaimRow key={claim.id} claim={claim} openDocument={async(path)=>{try{const {url}=await adminGetInsuranceDocumentUrl({data:{path}});window.open(url,"_blank","noopener,noreferrer");}catch(error:any){toast.error(error.message)}}} onDone={()=>refetchInsuranceClaims()}/>)}</div>}
        </Card>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-1 flex items-center font-display text-lg font-semibold">
            <Bell className="mr-2 h-4 w-4 text-primary" />
            Pending welcome bonus reviews
            {pendingKyc?.reviews.length ? (
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                {pendingKyc.reviews.length}
              </span>
            ) : null}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">Preview the submitted selfie or photo before approving the R10 welcome bonus.</p>
          {!pendingKyc?.reviews.length ? (
            <p className="text-sm text-muted-foreground">No welcome bonus photos are waiting for review.</p>
          ) : (
            <div className="space-y-3">
              {pendingKyc.reviews.map((review: any) => (
                <PendingKycRow
                  key={review.id}
                  review={review}
                  onOpenDocument={async (path) => {
                    try {
                      const { url } = await getKycProof({ data: { path } });
                      window.open(url, "_blank", "noopener,noreferrer");
                    } catch (error: any) { toast.error(error.message); }
                  }}
                  onReview={async (status) => {
                    try {
                      await setKycStatus({ data: { userId: review.id, status } });
                      toast.success(status === "verified" ? "KYC approved" : "KYC declined");
                      refetchPendingKyc();
                    } catch (error: any) { toast.error(error.message); }
                  }}
                />
              ))}
            </div>
          )}
        </Card>

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

        {COMMUNITY_FEATURE_ENABLED && <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-4 flex items-center font-display text-lg font-semibold">
            <Flag className="mr-2 h-4 w-4 text-primary" />
            Community reports
            {communityReports?.length ? (
              <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                {communityReports.length}
              </span>
            ) : null}
          </h2>
          {!communityReports?.length ? (
            <p className="text-sm text-muted-foreground">No community messages are waiting for review.</p>
          ) : (
            <div className="space-y-3">
              {communityReports.map((report: any) => {
                const message = report.community_messages;
                return (
                  <div key={report.id} className="rounded-xl border border-border bg-background/70 p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="font-semibold">{message?.author_name ?? "Community member"}</div>
                        <div className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
                          {message?.account_id ?? "Member"} · {message?.created_at ? new Date(message.created_at).toLocaleString() : ""}
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">Reason: {report.reason}</p>
                        {message?.body && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.body}</p>}
                        {message?.image_path && <p className="mt-2 text-xs text-muted-foreground">Image attached: {message.image_path}</p>}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            try {
                              const { error } = await supabase
                                .from("community_reports" as any)
                                .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: me.profile.id })
                                .eq("id", report.id);
                              if (error) throw new Error(error.message);
                              toast.success("Report dismissed");
                              refetchCommunityReports();
                            } catch (error: any) { toast.error(error.message); }
                          }}
                        >
                          Dismiss
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={async () => {
                            if (!message?.id || !confirm("Hide this community message?")) return;
                            try {
                              const hidden = await supabase
                                .from("community_messages" as any)
                                .update({ deleted_at: new Date().toISOString() })
                                .eq("id", message.id);
                              if (hidden.error) throw new Error(hidden.error.message);
                              const resolved = await supabase
                                .from("community_reports" as any)
                                .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: me.profile.id })
                                .eq("id", report.id);
                              if (resolved.error) throw new Error(resolved.error.message);
                              toast.success("Message hidden and report resolved");
                              refetchCommunityReports();
                            } catch (error: any) { toast.error(error.message); }
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Hide
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>}

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

function downloadWithdrawalPdf(w: any) {
  const p = w.profiles ?? {};
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
    ["Bank name", p.bank_name ?? "Not set"],
    ["Account number", p.bank_account_number ?? "Not set"],
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

function formatBalanceValues(values?: Record<string, number>) {
  const amounts = CURRENCIES.filter((currency) => Number(values?.[currency] ?? 0) !== 0).map((currency) => formatMoney(Number(values?.[currency] ?? 0), currency));
  return amounts.length ? amounts.join(" · ") : formatMoney(0, "ZAR");
}

function formatLastSeen(value?: string | null) {
  if (!value) return "No activity recorded";
  const lastSeen = new Date(value);
  if (Number.isNaN(lastSeen.getTime())) return "Unavailable";
  return lastSeen.toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
}

function RegisteredUserRow({ user, metrics, onChanged }: { user: any; metrics?: any; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const dispute = user.latest_dispute;

  const deleteUser = async () => {
    const confirmation = prompt(
      `This permanently deletes ${user.first_name} ${user.surname}, all account data and private files, and bans only ${user.email} from registering again.\n\nType the user's email to confirm:`,
    );
    if (confirmation?.trim().toLowerCase() !== String(user.email).trim().toLowerCase()) {
      if (confirmation !== null) toast.error("Email confirmation did not match");
      return;
    }
    setBusy(true);
    try {
      const result = await adminDeleteUserAndBanEmail({ data: { userId: user.id } });
      toast.success(`User deleted and ${result.bannedEmail} permanently banned`);
      onChanged();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const changeFreeze = async (frozen: boolean) => {
    if (frozen && reason.trim().length < 5) {
      toast.error("Provide a reason for freezing this account");
      return;
    }
    if (!confirm(frozen ? `Freeze ${user.first_name} ${user.surname}'s account?` : "Unfreeze this account?")) return;
    setBusy(true);
    try {
      await adminSetAccountFrozen({ data: {
        userId: user.id,
        frozen,
        reason: frozen ? reason.trim() : undefined,
        adminNote: !frozen ? reviewNote.trim() || undefined : undefined,
      } });
      toast.success(frozen ? "Account frozen" : "Account unfrozen");
      setReason("");
      setReviewNote("");
      onChanged();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-xl border p-4 ${user.account_frozen ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-background/40"}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-display font-semibold">{user.first_name} {user.surname}</div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${user.account_frozen ? "bg-destructive/15 text-destructive" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"}`}>
              {user.account_frozen ? "Frozen" : "Active"}
            </span>
          </div>
          <div className="mt-1 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
            <span>{user.email}</span>
            <span>{user.phone || "No phone number"}</span>
            <span>Account ID: <span className="font-mono text-foreground">{user.account_id}</span></span>
            <span className="break-all">User ID: <span className="font-mono text-xs text-foreground">{user.id}</span></span>
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${user.is_online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
              Last seen: {formatLastSeen(user.last_seen_at)}
            </span>
          </div>
          <div className="mt-3 grid max-w-md grid-cols-2 gap-2">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Withdrawable</div><div className="mt-0.5 text-sm font-semibold text-foreground">{formatBalanceValues(metrics?.withdrawable)}</div></div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Growing</div><div className="mt-0.5 text-sm font-semibold text-foreground">{formatBalanceValues(metrics?.growing)}</div></div>
          </div>
          {user.account_frozen && user.freeze_reason && (
            <p className="mt-3 text-sm"><span className="font-medium">Freeze reason:</span> {user.freeze_reason}</p>
          )}
        </div>
        <div className="w-full shrink-0 space-y-2 lg:w-80">
          {user.account_frozen ? (
            <>
              {dispute?.status === "pending" && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  <div className="font-medium text-amber-800 dark:text-amber-200">Dispute awaiting review</div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{dispute.statement}</p>
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        const { url } = await adminGetAccountDisputeUrl({ data: { path: dispute.document_path } });
                        window.open(url, "_blank", "noopener,noreferrer");
                      } catch (error: any) { toast.error(error.message); }
                    }}
                  >
                    <FileDown className="mr-2 h-4 w-4" /> Open PDF evidence
                  </Button>
                </div>
              )}
              <Textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Review note (recommended)" maxLength={1000} />
              <div className="flex gap-2">
                <Button className="flex-1" disabled={busy} onClick={() => changeFreeze(false)}>
                  <UnlockKeyhole className="mr-2 h-4 w-4" /> Unfreeze
                </Button>
                {dispute?.status === "pending" && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (reviewNote.trim().length < 5) return toast.error("Provide a review note");
                      setBusy(true);
                      try {
                        await adminRejectAccountFreezeDispute({ data: { disputeId: dispute.id, adminNote: reviewNote.trim() } });
                        toast.success("Dispute rejected; account remains frozen");
                        setReviewNote("");
                        onChanged();
                      } catch (error: any) { toast.error(error.message); }
                      finally { setBusy(false); }
                    }}
                  >
                    Reject dispute
                  </Button>
                )}
              </div>
              <Button variant="destructive" className="w-full" disabled={busy} onClick={deleteUser}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete user and ban email
              </Button>
            </>
          ) : (
            <>
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for AML/compliance freeze" maxLength={500} />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="destructive" disabled={busy} onClick={() => changeFreeze(true)}>
                  <LockKeyhole className="mr-2 h-4 w-4" /> Freeze account
                </Button>
                <Button variant="destructive" disabled={busy} onClick={deleteUser}>
                  <Trash2 className="mr-2 h-4 w-4" /> Delete user
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
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
            Bank: <span className="font-medium text-foreground">{p?.bank_name ?? "Not set"}</span> · Acc:{" "}
            <span className="font-mono">{p?.bank_account_number ?? "Not set"}</span>
          </div>
          <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
            <strong>Saved payout account</strong>
            <span className="mt-0.5 block">Funds will be paid to the registered account shown above.</span>
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

function InsuranceApplicationRow({ application, openDocument, onDone }: { application:any; openDocument:(path:string)=>void; onDone:()=>void }) {
  const [credit,setCredit]=useState(""); const [note,setNote]=useState(""); const [busy,setBusy]=useState(false); const profile=application.profiles??{};
  const review=async(status:"approved"|"declined")=>{const amount=Number(credit);if(status==="approved"&&(!Number.isFinite(amount)||amount<=0))return toast.error("Enter a valid credit facility amount.");setBusy(true);try{await adminReviewInsuranceApplication({data:{applicationId:application.id,status,creditAmount:status==="approved"?amount:undefined,note:note.trim()||undefined}});toast.success(status==="approved"?"Insurance application approved.":"Insurance application declined.");onDone();}catch(error:any){toast.error(error.message)}finally{setBusy(false)}};
  return <div className="rounded-xl border bg-background/50 p-4"><div className="font-semibold">{profile.first_name} {profile.surname} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{profile.account_id}</span></div><div className="text-xs text-muted-foreground">{profile.email} · {new Date(application.created_at).toLocaleString()}</div><div className="mt-2 text-sm"><strong>Items:</strong> {application.selected_items.join(", ")}</div><div className="mt-3 flex flex-wrap gap-2">{application.bank_statement_paths.map((path:string,index:number)=><Button key={path} size="sm" variant="outline" onClick={()=>openDocument(path)}><FileDown className="mr-2 h-4 w-4"/>Bank statement {index+1}</Button>)}<Button size="sm" variant="outline" onClick={()=>openDocument(application.payslip_path)}><FileDown className="mr-2 h-4 w-4"/>Payslip</Button><Button size="sm" variant="outline" onClick={()=>openDocument(application.id_copy_path)}><FileDown className="mr-2 h-4 w-4"/>ID copy</Button></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><Input type="number" min="1" step="0.01" placeholder="Credit facility amount (ZAR)" value={credit} onChange={event=>setCredit(event.target.value)}/><Input placeholder="Optional review note" value={note} onChange={event=>setNote(event.target.value)}/></div><div className="mt-3 flex gap-2"><Button disabled={busy} className="gradient-brand text-white" onClick={()=>review("approved")}><CheckCircle2 className="mr-2 h-4 w-4"/>Approve & allocate credit</Button><Button disabled={busy} variant="destructive" onClick={()=>review("declined")}><XCircle className="mr-2 h-4 w-4"/>Decline</Button></div></div>;
}

function InsuranceClaimRow({ claim, openDocument, onDone }: { claim:any; openDocument:(path:string)=>void; onDone:()=>void }) {
  const [amount,setAmount]=useState(String(claim.requested_amount)); const [note,setNote]=useState(""); const [busy,setBusy]=useState(false); const profile=claim.profiles??{};
  const review=async(status:"approved"|"declined")=>{const value=Number(amount);if(status==="approved"&&(!Number.isFinite(value)||value<=0||value>Number(claim.requested_amount)))return toast.error("Approved amount must be positive and cannot exceed the requested amount.");setBusy(true);try{await adminReviewInsuranceClaim({data:{claimId:claim.id,status,approvedAmount:status==="approved"?value:undefined,note:note.trim()||undefined}});toast.success(status==="approved"?"Claim approved and wallet credited.":"Claim declined.");onDone();}catch(error:any){toast.error(error.message)}finally{setBusy(false)}};
  return <div className="rounded-xl border bg-background/50 p-4"><div className="font-semibold">{profile.first_name} {profile.surname} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{profile.account_id}</span></div><div className="text-xs text-muted-foreground">{profile.email} · {new Date(claim.created_at).toLocaleString()}</div><div className="mt-2 text-sm"><strong>{claim.item}</strong> · Requested {formatMoney(Number(claim.requested_amount),"ZAR")}</div><Button className="mt-3" size="sm" variant="outline" onClick={()=>openDocument(claim.quotation_path)}><FileDown className="mr-2 h-4 w-4"/>Open quotation</Button><div className="mt-3 grid gap-2 sm:grid-cols-2"><Input type="number" min="1" max={claim.requested_amount} step="0.01" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="Approved payout amount"/><Input value={note} onChange={event=>setNote(event.target.value)} placeholder="Optional processing note"/></div><div className="mt-3 flex gap-2"><Button disabled={busy} className="gradient-brand text-white" onClick={()=>review("approved")}><CheckCircle2 className="mr-2 h-4 w-4"/>Approve & credit wallet</Button><Button disabled={busy} variant="destructive" onClick={()=>review("declined")}><XCircle className="mr-2 h-4 w-4"/>Decline</Button></div></div>;
}

function PendingKycRow({
  review,
  onOpenDocument,
  onReview,
}: {
  review: any;
  onOpenDocument: (path: string) => Promise<void>;
  onReview: (status: "verified" | "rejected") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"verified" | "rejected" | null>(null);

  const reviewKyc = async (status: "verified" | "rejected") => {
    setBusy(status);
    try {
      await onReview(status);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-display text-base font-semibold">
            {review.first_name} {review.surname}{" "}
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{review.account_id}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {review.email} {review.phone ? `· ${review.phone}` : ""}
          </div>
        </div>

        <div className="text-xs text-muted-foreground">Submitted for review</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onOpenDocument(review.selfie_url)}>
          <FileDown className="mr-2 h-4 w-4" /> Open selfie or photo
        </Button>
        <Button size="sm" className="gradient-brand text-white" disabled={busy !== null} onClick={() => reviewKyc("verified")}>
          {busy === "verified" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />} Approve & credit R10
        </Button>
        <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => reviewKyc("rejected")}>
          {busy === "rejected" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />} Decline
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
