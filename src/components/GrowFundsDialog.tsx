import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { moveWithdrawableToGrowing } from "@/lib/app-api";
import { formatMoney, type Currency } from "@/lib/currency";
import {
  estimatedMaturityDate,
  expectedCycleAmount,
  formatCycleDate,
  getGrowthCycle,
  GROWTH_CYCLES,
  validateCycleAmount,
  type GrowthCycleCode,
} from "@/lib/growth-cycles";

type StartedCycle = {
  maturityDate: string;
  expectedAmount: number;
  cycleLabel: string;
  amount: number;
};

export function GrowFundsDialog({
  open,
  onOpenChange,
  currency,
  withdrawable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currency: Currency;
  withdrawable: number;
}) {
  const [cycleCode, setCycleCode] = useState<GrowthCycleCode>("15d");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [startedCycle, setStartedCycle] = useState<StartedCycle | null>(null);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const queryClient = useQueryClient();

  const cycle = getGrowthCycle(cycleCode);
  const amountValue = Number(amount);
  const rangeError = amount ? validateCycleAmount(amountValue, cycle) : null;
  const availabilityError =
    amount && !rangeError && amountValue > withdrawable
      ? `Only ${formatMoney(withdrawable, "ZAR")} is currently withdrawable.`
      : null;
  const amountError = rangeError ?? availabilityError;
  const expectedAmount = amount && !amountError ? expectedCycleAmount(amountValue, cycle) : null;

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setAmount("");
      setStartedCycle(null);
      requestRef.current = null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move funds to growing</DialogTitle>
          <DialogDescription>
            Available to move: {formatMoney(withdrawable, currency)}
          </DialogDescription>
        </DialogHeader>

        {startedCycle ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4" /> {startedCycle.cycleLabel} cycle started
              </div>
              <p className="mt-2 leading-relaxed">
                {formatMoney(startedCycle.amount, "ZAR")} is locked until{" "}
                {formatCycleDate(startedCycle.maturityDate)}. Expected withdrawable amount:{" "}
                <strong>{formatMoney(startedCycle.expectedAmount, "ZAR")}</strong>.
              </p>
            </div>
            <Button type="button" className="w-full" onClick={() => close(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const validationError = validateCycleAmount(amountValue, cycle);
              if (validationError) return toast.error(validationError);
              if (amountValue > withdrawable)
                return toast.error("Only withdrawable funds can be moved to growing");

              const requestKey = `ZAR:${cycleCode}:${amountValue.toFixed(2)}`;
              if (requestRef.current?.key !== requestKey) {
                requestRef.current = { key: requestKey, id: crypto.randomUUID() };
              }

              setLoading(true);
              try {
                const result = await moveWithdrawableToGrowing({
                  data: {
                    amount: amountValue,
                    currency: "ZAR",
                    cycleCode,
                    requestId: requestRef.current.id,
                  },
                });
                setStartedCycle({
                  maturityDate: result.maturityDate,
                  expectedAmount: Number(result.expectedAmount),
                  cycleLabel: result.cycleLabel,
                  amount: Number(result.amount),
                });
                toast.success(
                  `${formatMoney(result.amount, "ZAR")} locked in the ${result.cycleLabel} cycle.`,
                );
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["me"] }),
                  queryClient.invalidateQueries({ queryKey: ["account-health"] }),
                ]);
              } catch (error: unknown) {
                toast.error(
                  error instanceof Error ? error.message : "Unable to move funds to growing",
                );
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label>Choose a ZAR growth cycle</Label>
              <RadioGroup
                className="mt-2 grid grid-cols-2 gap-2"
                value={cycleCode}
                onValueChange={(value) => setCycleCode(value as GrowthCycleCode)}
              >
                {GROWTH_CYCLES.map((option) => (
                  <label
                    key={option.code}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm transition-colors ${
                      option.code === cycleCode
                        ? "border-primary bg-primary/10"
                        : "border-border/60 hover:bg-muted/40"
                    }`}
                  >
                    <RadioGroupItem value={option.code} className="mt-0.5" />
                    <span>
                      <span className="block font-semibold">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatMoney(option.minAmount, "ZAR")} –{" "}
                        {formatMoney(option.maxAmount, "ZAR")}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </div>

            <div>
              <Label htmlFor="grow-amount">Amount (ZAR)</Label>
              <Input
                id="grow-amount"
                type="number"
                min={cycle.minAmount}
                max={Math.min(cycle.maxAmount, withdrawable)}
                step="0.01"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={String(cycle.minAmount)}
                aria-invalid={Boolean(amountError)}
              />
              {amountError && <p className="mt-1 text-xs text-destructive">{amountError}</p>}
            </div>

            {expectedAmount !== null && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm leading-relaxed text-emerald-900 dark:text-emerald-200">
                Lock {formatMoney(amountValue, "ZAR")} for {cycle.shortLabel}. Expected withdrawable
                amount on {formatCycleDate(estimatedMaturityDate(cycle.termDays))}:{" "}
                <strong>{formatMoney(expectedAmount, "ZAR")}</strong>.
              </div>
            )}

            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              This is a one-way move. The funds cannot return to withdrawable before the selected
              cycle matures.
            </div>
            <Button
              type="submit"
              className="w-full gradient-brand text-white"
              disabled={loading || withdrawable <= 0 || Boolean(amountError)}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Start {cycle.label} cycle
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
