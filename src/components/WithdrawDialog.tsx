import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCY_META, type Currency } from "@/lib/currency";
import { useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { requestWithdrawal } from "@/lib/wallet.functions";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

export function WithdrawDialog({
  open,
  onOpenChange,
  currency,
  balance,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currency: Currency;
  balance: number;
}) {
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const req = useServerFn(requestWithdrawal);
  const qc = useQueryClient();

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setDone(false); }}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request a withdrawal</DialogTitle>
          <DialogDescription>
            Available in {currency}: {CURRENCY_META[currency].symbol}
            {balance.toFixed(2)}
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
              if (amt > balance) return toast.error("Insufficient balance");
              setLoading(true);
              try {
                await req({ data: { amount: amt, currency, bankDetails: bank || undefined } });
                setDone(true);
                await qc.invalidateQueries();
              } catch (err: any) {
                toast.error(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label htmlFor="wamt">Amount ({currency})</Label>
              <Input id="wamt" type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="bd">Bank details (optional)</Label>
              <Textarea id="bd" placeholder="Bank name, account number, branch..." value={bank} onChange={(e) => setBank(e.target.value)} />
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