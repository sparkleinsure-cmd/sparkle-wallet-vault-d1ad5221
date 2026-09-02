import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/currency";
import {
  estimatedMaturityDate,
  expectedCycleAmount,
  formatCycleDate,
  getGrowthCycle,
  GROWTH_CYCLES,
  validateCycleAmount,
  type GrowthCycleCode,
} from "@/lib/growth-cycles";

export const Route = createFileRoute("/cycle-preview")({
  head: () => ({
    meta: [
      { title: "Growth Cycle Preview — Sparkle Insure" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CyclePreviewPage,
});

function CyclePreviewPage() {
  const [memberCycleCode, setMemberCycleCode] = useState<GrowthCycleCode>("180d");
  const [memberAmount, setMemberAmount] = useState("10000");
  const [adminCycleCode, setAdminCycleCode] = useState<GrowthCycleCode>("180d");
  const [verifiedAmount, setVerifiedAmount] = useState("10000");

  const memberCycle = getGrowthCycle(memberCycleCode);
  const memberValue = Number(memberAmount);
  const memberError = validateCycleAmount(memberValue, memberCycle);
  const adminCycle = getGrowthCycle(adminCycleCode);
  const verifiedValue = Number(verifiedAmount);
  const adminError = validateCycleAmount(verifiedValue, adminCycle);

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-900 dark:text-sky-200">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5" /> Safe preview — no real funds or account data are
            changed
          </div>
          <p className="mt-1">
            Try different cycles and amounts below. All action buttons are intentionally disabled.
          </p>
        </div>

        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-primary">Sparkle Insure</div>
          <h1 className="mt-1 font-display text-3xl font-bold">Growth-cycle preview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Member deposit experience and administrator verification controls.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold">Member deposit</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose the cycle before uploading proof of payment.
            </p>

            <div className="mt-5">
              <Label>Choose a ZAR growth cycle</Label>
              <RadioGroup
                className="mt-2 grid grid-cols-2 gap-2"
                value={memberCycleCode}
                onValueChange={(value) => {
                  setMemberCycleCode(value as GrowthCycleCode);
                  setAdminCycleCode(value as GrowthCycleCode);
                }}
              >
                {GROWTH_CYCLES.map((cycle) => (
                  <label
                    key={cycle.code}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm ${
                      cycle.code === memberCycleCode
                        ? "border-primary bg-primary/10"
                        : "border-border/60"
                    }`}
                  >
                    <RadioGroupItem value={cycle.code} className="mt-0.5" />
                    <span>
                      <span className="block font-semibold">{cycle.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatMoney(cycle.minAmount, "ZAR")} –{" "}
                        {formatMoney(cycle.maxAmount, "ZAR")}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </div>

            <div className="mt-4">
              <Label htmlFor="preview-member-amount">Amount deposited (ZAR)</Label>
              <Input
                id="preview-member-amount"
                type="number"
                step="0.01"
                value={memberAmount}
                onChange={(event) => {
                  setMemberAmount(event.target.value);
                  setVerifiedAmount(event.target.value);
                }}
                aria-invalid={Boolean(memberError)}
              />
              {memberError && <p className="mt-1 text-xs text-destructive">{memberError}</p>}
            </div>

            {!memberError && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm leading-relaxed text-emerald-900 dark:text-emerald-200">
                Lock {formatMoney(memberValue, "ZAR")} for {memberCycle.shortLabel}. If approved
                today, the estimated maturity date is{" "}
                {formatCycleDate(estimatedMaturityDate(memberCycle.termDays))}. Expected
                withdrawable amount:{" "}
                <strong>{formatMoney(expectedCycleAmount(memberValue, memberCycle), "ZAR")}</strong>
                .
              </div>
            )}

            <Button className="mt-4 w-full" disabled>
              Preview only — submit disabled
            </Button>
          </Card>

          <Card className="rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold">Admin verification</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Compare the proof, correct the amount, reassign its cycle, or decline it.
            </p>

            <div className="mt-5 rounded-xl border border-border/60 bg-muted/30 p-4">
              <div className="text-sm font-semibold">Preview Member · SPARKLE1</div>
              <div className="mt-1 text-2xl font-bold text-primary">
                {formatMoney(memberValue || 0, "ZAR")}
              </div>
              <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Member selected: {memberCycle.label}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="preview-verified-amount">Verified proof amount</Label>
                <Input
                  id="preview-verified-amount"
                  type="number"
                  step="0.01"
                  value={verifiedAmount}
                  onChange={(event) => setVerifiedAmount(event.target.value)}
                  aria-invalid={Boolean(adminError)}
                />
              </div>
              <div>
                <Label>Allocate to cycle</Label>
                <Select
                  value={adminCycleCode}
                  onValueChange={(value) => setAdminCycleCode(value as GrowthCycleCode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GROWTH_CYCLES.map((cycle) => (
                      <SelectItem key={cycle.code} value={cycle.code}>
                        {cycle.label} · {formatMoney(cycle.minAmount, "ZAR")}–
                        {formatMoney(cycle.maxAmount, "ZAR")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {adminError ? (
              <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {adminError}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-200">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="h-4 w-4" /> Ready to allocate
                </div>
                <p className="mt-1">
                  {formatMoney(verifiedValue, "ZAR")} will enter the {adminCycle.label} cycle.
                  Expected withdrawable amount:{" "}
                  <strong>
                    {formatMoney(expectedCycleAmount(verifiedValue, adminCycle), "ZAR")}
                  </strong>
                  .
                </p>
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <Button className="flex-1" disabled>
                Approve & allocate
              </Button>
              <Button className="flex-1" variant="destructive" disabled>
                Decline deposit
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
