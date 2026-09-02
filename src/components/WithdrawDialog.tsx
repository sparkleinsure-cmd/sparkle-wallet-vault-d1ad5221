import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { requestWithdrawal } from "@/lib/app-api";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

export function WithdrawDialog({
  open,
  onOpenChange,
  currency,
  balance,
  withdrawable,
  bankName,
  accountLast4,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currency: Currency;
  balance: number;
  withdrawable: number;
  bankName?: string | null;
  accountLast4?: string | null;
}) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const req = requestWithdrawal;
  const qc = useQueryClient();

  const submit = async () => {
    const amt = Number(amount);
    const requestKey = `${currency}:${amt.toFixed(2)}`;
    if (requestRef.current?.key !== requestKey) {
      requestRef.current = { key: requestKey, id: crypto.randomUUID() };
    }
    setLoading(true);
    try {
      const result = await req({
        data: {
          amount: amt,
          currency,
          requestId: requestRef.current.id,
        },
      });
      setDone(true);
      toast.success(`${formatMoney(result.payoutAmount, currency)} will be paid to your bank.`);
      await qc.invalidateQueries();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => {
      onOpenChange(v);
      if (!v) {
        setDone(false);
        setAmount("");
        requestRef.current = null;
      }
    }}>
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
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const amt = Number(amount);
              if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
              if (amt > withdrawable) return toast.error("Only matured funds are withdrawable. Locked 30-day cycles cannot be withdrawn early.");
              await submit();
            }}
          >
            <div>
              <Label htmlFor="wamt">Amount ({currency})</Label>
              <Input id="wamt" type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="rounded-xl border bg-muted/40 p-3 text-sm">
              {accountLast4 ? <>Funds will be paid to your saved {bankName ?? "bank"} account ending in <strong>{accountLast4}</strong>.</> : <>Add your banking details in Settings before requesting a withdrawal.</>}
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
