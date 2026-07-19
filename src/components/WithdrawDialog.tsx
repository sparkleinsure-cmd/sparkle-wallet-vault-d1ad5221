import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { requestWithdrawal } from "@/lib/wallet.functions";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle } from "lucide-react";

export function WithdrawDialog({
  open,
  onOpenChange,
  currency,
  balance,
  withdrawable,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currency: Currency;
  balance: number;
  withdrawable: number;
}) {
  const [amount, setAmount] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [breakConfirm, setBreakConfirm] = useState(false);
  const req = useServerFn(requestWithdrawal);
  const qc = useQueryClient();
  const requestedAmount = Number(amount);
  const breaksGrowingTranche = Number.isFinite(requestedAmount)
    && requestedAmount > 0
    && requestedAmount > withdrawable;
  const growingAmount = Math.max(0, requestedAmount - withdrawable);
  const penalty = Math.round(growingAmount * 0.05 * 100) / 100;
  const payoutAmount = Math.max(0, requestedAmount - penalty);

  const submit = async (confirmBreak: boolean) => {
    const amt = Number(amount);
    setLoading(true);
    try {
      const result = await req({
        data: {
          amount: amt,
          currency,
          bankName: bankName.trim() || undefined,
          accountNumber: accountNumber.trim() || undefined,
          confirmBreak,
        },
      });
      setDone(true);
      setBreakConfirm(false);
      toast.success(result.penalty > 0
        ? `${formatMoney(result.payoutAmount, currency)} will be paid after a ${formatMoney(result.penalty, currency)} penalty.`
        : `${formatMoney(result.payoutAmount, currency)} will be paid to your bank.`);
      await qc.invalidateQueries();
    } catch (err: any) {
      if (err?.message === "BREAKS_TRANCHE") {
        setBreakConfirm(true);
      } else {
        toast.error(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setDone(false); setBreakConfirm(false); } }}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request a withdrawal</DialogTitle>
          <DialogDescription>
            Withdrawable in {currency}: {CURRENCY_META[currency].symbol}
            {withdrawable.toFixed(2)} · Total: {CURRENCY_META[currency].symbol}{balance.toFixed(2)}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-300">
            Your withdrawal is being processed and will reflect in your account in 24 hours.
          </div>
        ) : breakConfirm ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
              <div className="mb-1 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" /> Warning
              </div>
              <p>A 5% penalty applies to the {formatMoney(growingAmount, currency)} taken from a still-growing cycle.</p>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div><span className="block text-muted-foreground">Requested</span><strong>{formatMoney(requestedAmount, currency)}</strong></div>
                <div><span className="block text-muted-foreground">Penalty</span><strong>-{formatMoney(penalty, currency)}</strong></div>
                <div><span className="block text-muted-foreground">You receive</span><strong>{formatMoney(payoutAmount, currency)}</strong></div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setBreakConfirm(false)} disabled={loading}>
                Cancel
              </Button>
              <Button className="flex-1 gradient-brand text-white" onClick={() => submit(true)} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Proceed anyway
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const amt = Number(amount);
              if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
              if (amt > balance) return toast.error("Insufficient balance");
              await submit(false);
            }}
          >
            <div>
              <Label htmlFor="wamt">Amount ({currency})</Label>
              <Input id="wamt" type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
              {breaksGrowingTranche && (
                <div
                  role="alert"
                  className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>A 5% penalty applies to the still-growing portion. You will receive {formatMoney(payoutAmount, currency)} after a penalty of {formatMoney(penalty, currency)}.</span>
                  </div>
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="bn">Bank name</Label>
              <Input id="bn" required value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. FNB" />
            </div>
            <div>
              <Label htmlFor="an">Account number</Label>
              <Input id="an" inputMode="numeric" required value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Your bank account number" />
            </div>
            <Button type="submit" className="w-full gradient-brand text-white" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Request withdrawal
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
