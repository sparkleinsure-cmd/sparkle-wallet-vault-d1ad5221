import { useMemo, useState } from "react";
import { Link, useNavigate, createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  Copy,
  Loader2,
  MailPlus,
  ShieldCheck,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/Header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getMe,
  getRecruiterDashboard,
  recruiterInviteMember,
  setPayoutDetails,
  submitRecruiterApplication,
} from "@/lib/app-api";
import { PUBLIC_APP_ORIGIN } from "@/lib/public-url";

type RecruiterApplicationData = {
  id: string;
  status: "pending" | "approved" | "declined" | "suspended";
  appliedAt: string;
  approvedAt: string | null;
  reviewNote: string | null;
  bankName: string;
  bankAccountLast4: string;
};

type RecruiterReferral = {
  referralId: string;
  accountId: string;
  name: string;
  depositAmount: number | null;
  cycleLabel: string | null;
  qualifies: boolean;
};

type RecruiterSalaryHistory = {
  periodStart: string;
  periodEnd: string;
  salaryAmount: number;
  status: "paid" | "not_qualified" | "processing";
};

type RecruiterDashboardData = {
  application: RecruiterApplicationData | null;
  approved: boolean;
  period: {
    start: string;
    end: string;
    salaryDate: string;
    target: number;
    qualifyingDeposits: number;
    qualifyingRecruits: number;
    remaining: number;
    qualified: boolean;
  };
  recentReferrals: RecruiterReferral[];
  salaryHistory: RecruiterSalaryHistory[];
};

type RecruiterProfile = {
  bank_name?: string | null;
  bank_account_number?: string | null;
};

const recruiterPreview: RecruiterDashboardData = {
  application: {
    id: "preview",
    status: "approved",
    appliedAt: "2026-08-20T10:00:00+02:00",
    approvedAt: "2026-08-21T10:00:00+02:00",
    reviewNote: null,
    bankName: "Registered bank",
    bankAccountLast4: "1234",
  },
  approved: true,
  period: {
    start: "2026-08-29",
    end: "2026-09-27",
    salaryDate: "2026-09-28",
    target: 20000,
    qualifyingDeposits: 11000,
    qualifyingRecruits: 4,
    remaining: 9000,
    qualified: false,
  },
  recentReferrals: [
    {
      referralId: "1",
      accountId: "K8ND4W2P",
      name: "Lerato M.",
      depositAmount: 4000,
      cycleLabel: "30 Days",
      qualifies: true,
    },
    {
      referralId: "2",
      accountId: "TW9R3F7Q",
      name: "Ayanda N.",
      depositAmount: 3000,
      cycleLabel: "30 Days",
      qualifies: true,
    },
    {
      referralId: "3",
      accountId: "H5CP8M2X",
      name: "Kagiso T.",
      depositAmount: 4000,
      cycleLabel: "30 Days",
      qualifies: true,
    },
    {
      referralId: "4",
      accountId: "B7LS4J9A",
      name: "Naledi P.",
      depositAmount: null,
      cycleLabel: null,
      qualifies: false,
    },
  ],
  salaryHistory: [],
};

export const Route = createFileRoute("/_authenticated/recruiter")({
  validateSearch: (search: Record<string, unknown>) => ({
    preview: search.preview === "approved" ? "approved" : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Recruiter programme — Sparkle Insure" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RecruiterPage,
});

const money = (value: number) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(value);

const date = (value: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  }).format(new Date(value));

function RecruiterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { preview } = Route.useSearch();
  const isLocalPreview = import.meta.env.DEV;
  const showApprovedPreview = isLocalPreview && preview === "approved";
  const [previewApplication, setPreviewApplication] = useState<RecruiterApplicationData | null>(
    null,
  );
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const {
    data: dashboard,
    isLoading: dashboardLoading,
    refetch,
  } = useQuery<RecruiterDashboardData>({
    queryKey: ["recruiter-dashboard"],
    queryFn: getRecruiterDashboard,
    enabled: !isLocalPreview,
  });

  const visibleDashboard = showApprovedPreview
    ? recruiterPreview
    : isLocalPreview
      ? ({ application: previewApplication } as RecruiterDashboardData)
      : dashboard;

  if (meLoading || (!isLocalPreview && dashboardLoading) || !me?.profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const displayName =
    [String(me.profile.first_name ?? "").split(/\s+/)[0], me.profile.surname]
      .filter(Boolean)
      .join(" ") || "Member";

  return (
    <div className="min-h-screen">
      <AppHeader
        isAdmin={me.roles.includes("admin")}
        displayName={displayName}
        accountId={me.profile.account_id}
      />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6 md:py-10">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => navigate({ to: "/dashboard" })}
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
        </Button>

        <div>
          <div className="flex items-center gap-2">
            <BriefcaseBusiness className="h-7 w-7 text-violet-600" />
            <h1 className="font-display text-3xl font-bold">Recruiter programme</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {visibleDashboard?.application?.status === "approved"
              ? "Approved Recruiter's Dashboard"
              : "Apply to become an approved recruiter."}
          </p>
        </div>

        {isLocalPreview && (
          <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm">
            Preview mode: actions are simulated locally and no application or banking information is
            sent to production.
          </div>
        )}

        {!visibleDashboard?.application || visibleDashboard.application.status === "declined" ? (
          <RecruiterApplication
            profile={me.profile}
            previous={visibleDashboard?.application}
            previewOnly={isLocalPreview}
            onSubmitted={async () => {
              if (isLocalPreview) {
                setPreviewApplication({
                  id: "preview-pending",
                  status: "pending",
                  appliedAt: new Date().toISOString(),
                  approvedAt: null,
                  reviewNote: null,
                  bankName: String(me.profile.bank_name ?? "Registered bank"),
                  bankAccountLast4: String(me.profile.bank_account_number ?? "0000").slice(-4),
                });
                return;
              }
              await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ["me"] })]);
            }}
          />
        ) : visibleDashboard.application.status === "pending" ? (
          <ApplicationStatus application={visibleDashboard.application} />
        ) : visibleDashboard.application.status === "suspended" ? (
          <Card className="glass-card rounded-3xl p-6">
            <h2 className="font-display text-xl font-semibold">Recruiter access suspended</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Recruiter invitations and salary qualification are paused. Please contact Sparkle
              Insure support for the administrator&apos;s review outcome.
            </p>
            {visibleDashboard.application.reviewNote && (
              <p className="mt-4 rounded-xl bg-muted p-3 text-sm">
                {visibleDashboard.application.reviewNote}
              </p>
            )}
          </Card>
        ) : (
          <ApprovedDashboard
            dashboard={visibleDashboard}
            accountId={me.profile.account_id}
            onUpdated={refetch}
          />
        )}
      </main>
    </div>
  );
}

function RecruiterApplication({
  profile,
  previous,
  previewOnly,
  onSubmitted,
}: {
  profile: RecruiterProfile;
  previous?: RecruiterApplicationData;
  previewOnly: boolean;
  onSubmitted: () => Promise<void>;
}) {
  const hasRegisteredBank = Boolean(profile.bank_name && profile.bank_account_number);
  const [bankName, setBankName] = useState(profile.bank_name ?? "");
  const [accountNumber, setAccountNumber] = useState(profile.bank_account_number ?? "");
  const [agreement, setAgreement] = useState(false);
  const [declaration, setDeclaration] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!agreement || !declaration)
      return toast.error("Accept the agreement and declaration to apply");
    if (!bankName.trim() || !/^\d{4,40}$/.test(accountNumber.trim())) {
      return toast.error("Enter valid registered banking details");
    }
    setBusy(true);
    try {
      if (previewOnly) {
        await onSubmitted();
        toast.success("Preview: recruiter application moved to administrator review");
        return;
      }
      if (!hasRegisteredBank) {
        await setPayoutDetails({
          data: { bankName: bankName.trim(), accountNumber: accountNumber.trim() },
        });
      }
      await submitRecruiterApplication({ data: { declarationAccepted: true } });
      toast.success("Recruiter application submitted for administrator review");
      await onSubmitted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Application could not be submitted");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
      <Card className="glass-card rounded-3xl p-6">
        <h2 className="font-display text-xl font-semibold">Apply to become a recruiter</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Applications require administrator approval. Approved recruiters begin qualifying from
          their first complete 29th–27th period.
        </p>
        {previous?.reviewNote && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            Previous review: {previous.reviewNote}
          </div>
        )}

        <div className="mt-6 grid gap-4">
          <div>
            <Label htmlFor="recruiter-bank">Registered bank</Label>
            <Input
              id="recruiter-bank"
              value={bankName}
              disabled={hasRegisteredBank}
              onChange={(event) => setBankName(event.target.value)}
              placeholder="Bank name"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="recruiter-account">Account number</Label>
            <Input
              id="recruiter-account"
              value={hasRegisteredBank ? `•••• ${String(accountNumber).slice(-4)}` : accountNumber}
              disabled={hasRegisteredBank}
              onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
              placeholder="Account number"
              inputMode="numeric"
              className="mt-1"
            />
            {hasRegisteredBank && (
              <p className="mt-1 text-xs text-muted-foreground">
                These are your protected payout details. Use{" "}
                <Link to="/settings" className="underline">
                  Settings
                </Link>{" "}
                to request a change.
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 space-y-3 rounded-2xl border bg-background/60 p-4 text-sm">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={agreement}
              onChange={(event) => setAgreement(event.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              I accept the recruiter programme agreement, qualification rules and the current
              agreement version. I will only use approved Sparkle Insure information and will not
              make misleading statements or guarantees.
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={declaration}
              onChange={(event) => setDeclaration(event.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              I declare that I will perform my recruiter responsibilities, obtain consent before
              entering another person&apos;s details, and protect their personal information.
            </span>
          </label>
        </div>

        <Button onClick={submit} disabled={busy} className="mt-6 w-full gradient-brand text-white">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Submit recruiter application
        </Button>
      </Card>

      <ProgrammeRules />
    </div>
  );
}

function ProgrammeRules() {
  return (
    <Card className="glass-card rounded-3xl p-6">
      <ShieldCheck className="h-8 w-8 text-emerald-600" />
      <h2 className="mt-3 font-display text-xl font-semibold">How qualification works</h2>
      <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
        <li>
          • Your existing one-time 10% reward remains credited after a referred member&apos;s first
          approved deposit.
        </li>
        <li>• Salary progress only counts new members referred after recruiter approval.</li>
        <li>
          • Each member&apos;s first approved deposit must be at least R1,000 in the 30-day cycle.
        </li>
        <li>
          • Combined verified qualifying deposits must reach R20,000 from the 29th through the 27th.
        </li>
        <li>• If qualified, R3,000 is credited to your ZAR withdrawable wallet on the 28th.</li>
        <li>• Approvals on the 28th carry into the next qualification period.</li>
      </ul>
    </Card>
  );
}

function ApplicationStatus({ application }: { application: RecruiterApplicationData }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="glass-card rounded-3xl p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-amber-500/15 p-3 text-amber-700">
            <Loader2 className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Application under review</h2>
            <p className="text-sm text-muted-foreground">Submitted {date(application.appliedAt)}</p>
          </div>
        </div>
        <p className="mt-5 text-sm text-muted-foreground">
          You can continue using normal friends-and-family referrals while an administrator reviews
          your recruiter application.
        </p>
        <div className="mt-4 rounded-xl bg-muted p-3 text-sm">
          Registered bank: {application.bankName} · account ending {application.bankAccountLast4}
        </div>
      </Card>
      <ProgrammeRules />
    </div>
  );
}

function ApprovedDashboard({
  dashboard,
  accountId,
  onUpdated,
}: {
  dashboard: RecruiterDashboardData;
  accountId: string;
  onUpdated: () => Promise<unknown>;
}) {
  const period = dashboard.period;
  const progress = Math.min(100, (Number(period.qualifyingDeposits) / Number(period.target)) * 100);
  const referralUrl = useMemo(() => {
    const url = new URL("/auth", PUBLIC_APP_ORIGIN);
    url.searchParams.set("mode", "signup");
    url.searchParams.set("ref", accountId);
    return url.toString();
  }, [accountId]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat icon={Users} label="Recruits" value={String(period.qualifyingRecruits)} />
        <Stat icon={WalletCards} label="Monthly wallet credit" value="R3,000" />
        <Stat
          icon={CheckCircle2}
          label="Current status"
          value={period.qualified ? "Qualified" : "In progress"}
        />
      </div>

      <RecruiterProgressVisual
        progress={progress}
        deposits={Number(period.qualifyingDeposits)}
        target={Number(period.target)}
        remaining={Number(period.remaining)}
        qualified={period.qualified}
        periodStart={period.start}
        periodEnd={period.end}
        salaryDate={period.salaryDate}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="glass-card rounded-3xl p-6">
          <h2 className="font-display text-xl font-semibold">Your recruiter link</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Members can register themselves, or you can send a secure account invitation.
          </p>
          <div className="mt-4 flex gap-2">
            <Input value={referralUrl} readOnly aria-label="Recruiter referral link" />
            <Button
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(referralUrl);
                toast.success("Recruiter link copied");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Card>
        <InviteMember onInvited={onUpdated} />
      </div>

      <Card className="glass-card rounded-3xl p-6">
        <h2 className="font-display text-xl font-semibold">Recruitment activity</h2>
        <div className="mt-4 space-y-3">
          {(dashboard.recentReferrals ?? []).length === 0 ? (
            <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
              No new recruiter referrals yet.
            </p>
          ) : (
            dashboard.recentReferrals.map((referral) => (
              <div
                key={referral.referralId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
              >
                <div>
                  <p className="font-medium">{referral.name || referral.accountId}</p>
                  <p className="text-xs text-muted-foreground">
                    {referral.depositAmount
                      ? `${money(Number(referral.depositAmount))} · ${referral.cycleLabel ?? "Cycle unavailable"}`
                      : "Awaiting first approved deposit"}
                  </p>
                </div>
                <Badge variant={referral.qualifies ? "default" : "secondary"}>
                  {referral.qualifies ? "Counts toward target" : "Not qualifying yet"}
                </Badge>
              </div>
            ))
          )}
        </div>
      </Card>

      {(dashboard.salaryHistory ?? []).length > 0 && (
        <Card className="glass-card rounded-3xl p-6">
          <h2 className="font-display text-xl font-semibold">Salary history</h2>
          <div className="mt-4 space-y-2">
            {dashboard.salaryHistory.map((entry) => (
              <div
                key={entry.periodStart}
                className="flex items-center justify-between rounded-xl border p-3 text-sm"
              >
                <span>
                  {date(entry.periodStart)} – {date(entry.periodEnd)}
                </span>
                <span className="font-semibold">
                  {entry.status === "paid"
                    ? `${money(Number(entry.salaryAmount))} credited`
                    : "Target not reached"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function RecruiterProgressVisual({
  progress,
  deposits,
  target,
  remaining,
  qualified,
  periodStart,
  periodEnd,
  salaryDate,
}: {
  progress: number;
  deposits: number;
  target: number;
  remaining: number;
  qualified: boolean;
  periodStart: string;
  periodEnd: string;
  salaryDate: string;
}) {
  const ringSegments = 28;
  const barSegments = 20;
  const completedRingSegments = Math.round((progress / 100) * ringSegments);
  const completedBarSegments = Math.round((progress / 100) * barSegments);

  return (
    <Card className="glass-card overflow-hidden rounded-3xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Current qualification period</p>
          <h2 className="font-display text-2xl font-bold">Progress to monthly salary</h2>
        </div>
        <Badge variant={qualified ? "default" : "secondary"}>
          {qualified ? "Target reached" : "In progress"}
        </Badge>
      </div>

      <div className="mt-6 grid items-center gap-8 md:grid-cols-[220px_1fr]">
        <div
          className="relative mx-auto h-44 w-44"
          role="progressbar"
          aria-label="Recruiter salary progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <svg viewBox="0 0 120 120" className="h-full w-full" aria-hidden="true">
            {Array.from({ length: ringSegments }, (_, index) => (
              <line
                key={index}
                x1="60"
                y1="8"
                x2="60"
                y2="18"
                transform={`rotate(${(360 / ringSegments) * index} 60 60)`}
                strokeWidth="5"
                strokeLinecap="round"
                className={
                  index < completedRingSegments
                    ? "stroke-cyan-500"
                    : "stroke-slate-200 dark:stroke-slate-700"
                }
              />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display text-4xl font-bold text-cyan-600">
              {Math.round(progress)}%
            </span>
            <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              progress
            </span>
          </div>
        </div>

        <div>
          <p className="font-display text-lg font-semibold">
            {qualified ? "Your monthly target is complete" : "Building toward your next R3,000"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Every eligible 30-day deposit moves your milestone forward.
          </p>

          <div
            className="mt-6 flex gap-1"
            role="progressbar"
            aria-label="Deposit milestone progress"
            aria-valuemin={0}
            aria-valuemax={target}
            aria-valuenow={Math.min(deposits, target)}
          >
            {Array.from({ length: barSegments }, (_, index) => (
              <span
                key={index}
                className={`h-3 flex-1 -skew-x-[18deg] rounded-[2px] transition-colors ${
                  index < completedBarSegments
                    ? "bg-gradient-to-r from-cyan-500 to-teal-400"
                    : "bg-slate-200 dark:bg-slate-700"
                }`}
              />
            ))}
          </div>

          <div className="mt-3 flex justify-between gap-4 text-xs text-muted-foreground">
            <span>{money(deposits)} deposited</span>
            <span>{money(target)} target</span>
          </div>
          <p className="mt-3 text-xs font-medium text-cyan-700 dark:text-cyan-300">
            {qualified ? "Milestone achieved" : `${money(remaining)} remaining`}
          </p>
          <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
            {date(periodStart)} – {date(periodEnd)} · Salary day {date(salaryDate)}
          </p>
        </div>
      </div>
    </Card>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <Card className="glass-card rounded-2xl p-4">
      <Icon className="h-5 w-5 text-violet-600" />
      <p className="mt-3 text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-lg font-bold">{value}</p>
    </Card>
  );
}

function InviteMember({ onInvited }: { onInvited: () => Promise<unknown> }) {
  const [form, setForm] = useState({ firstName: "", surname: "", email: "", phone: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!consent) return toast.error("Confirm the member's consent before sending an invitation");
    setBusy(true);
    try {
      await recruiterInviteMember({ data: { ...form, consentAttested: true } });
      toast.success("Secure invitation sent. The member will create their own password by email");
      setForm({ firstName: "", surname: "", email: "", phone: "" });
      setConsent(false);
      await onInvited();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invitation could not be sent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="glass-card rounded-3xl p-6">
      <div className="flex items-center gap-2">
        <MailPlus className="h-5 w-5 text-violet-600" />
        <h2 className="font-display text-xl font-semibold">Invite a new member</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sparkle Insure emails a protected invitation. You never create or see the member&apos;s
        password.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Input
          placeholder="First name"
          value={form.firstName}
          onChange={(e) => setForm({ ...form, firstName: e.target.value })}
        />
        <Input
          placeholder="Surname"
          value={form.surname}
          onChange={(e) => setForm({ ...form, surname: e.target.value })}
        />
        <Input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Input
          placeholder="Phone number"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </div>
      <label className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        The person gave me permission to submit these details and receive this invitation.
      </label>
      <Button onClick={submit} disabled={busy} className="mt-4 w-full">
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send secure invitation
      </Button>
    </Card>
  );
}
