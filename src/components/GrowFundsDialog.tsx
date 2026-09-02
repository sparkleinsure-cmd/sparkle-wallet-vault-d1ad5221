import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, type Currency } from "@/lib/currency";
import { moveWithdrawableToGrowing } from "@/lib/app-api";

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
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [maturityDate, setMaturityDate] = useState<string | null>(null);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const queryClient = useQueryClient();

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setAmount("");
      setMaturityDate(null);
      requestRef.current = null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move funds to growing</DialogTitle>
          <DialogDescription>Available to move: {formatMoney(withdrawable, currency)}</DialogDescription>
        </DialogHeader>

        {maturityDate ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4" /> New growing cycle started
              </div>
              <p className="mt-1">These funds will become withdrawable again on {new Date(maturityDate).toLocaleDateString()}.</p>
            </div>
            <Button type="button" className="w-full" onClick={() => close(false)}>Done</Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const value = Number(amount);
              if (!Number.isFinite(value) || value <= 0) return toast.error("Enter a valid amount");
              if (value > withdrawable) return toast.error("Only withdrawable funds can be moved to growing");

              const requestKey = `${currency}:${value.toFixed(2)}`;
              if (requestRef.current?.key !== requestKey) {
                requestRef.current = { key: requestKey, id: crypto.randomUUID() };
              }

              setLoading(true);
              try {
                const result = await moveWithdrawableToGrowing({
                  data: { amount: value, currency, requestId: requestRef.current.id },
                });
                setMaturityDate(result.maturityDate);
                toast.success(`${formatMoney(result.amount, currency)} moved to a new 30-day growing cycle.`);
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["me"] }),
                  queryClient.invalidateQueries({ queryKey: ["account-health"] }),
                ]);
              } catch (error: unknown) {
                toast.error(error instanceof Error ? error.message : "Unable to move funds to growing");
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label htmlFor="grow-amount">Amount ({currency})</Label>
              <Input
                id="grow-amount"
                type="number"
                min="0.01"
                max={withdrawable}
                step="0.01"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              This is a one-way move into a new 30-day growing cycle. The funds cannot be moved back to withdrawable before the cycle matures.
            </div>
            <Button type="submit" className="w-full gradient-brand text-white" disabled={loading || withdrawable <= 0}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              Start 30-day cycle
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
