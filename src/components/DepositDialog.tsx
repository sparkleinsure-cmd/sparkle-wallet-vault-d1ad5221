import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, CURRENCY_META, type Currency } from "@/lib/currency";
import { useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { creditDeposit } from "@/lib/wallet.functions";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

// Replace with real Paystack public key for live payments.
const PAYSTACK_PUBLIC_KEY =
  import.meta.env.VITE_PAYSTACK_PUBLIC_KEY || "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

declare global {
  interface Window {
    PaystackPop?: {
      setup: (opts: {
        key: string;
        email: string;
        amount: number;
        currency: string;
        ref?: string;
        callback: (r: { reference: string }) => void;
        onClose?: () => void;
      }) => { openIframe: () => void };
    };
  }
}

export function DepositDialog({
  open,
  onOpenChange,
  defaultCurrency,
  email,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultCurrency: Currency;
  email: string;
}) {
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const credit = useServerFn(creditDeposit);
  const qc = useQueryClient();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deposit to your wallet</DialogTitle>
          <DialogDescription>
            Fund your Sparkle Insure wallet securely via Paystack. Choose your currency and amount below.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const amt = Number(amount);
            if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
            if (!window.PaystackPop) return toast.error("Paystack SDK not loaded yet — try again.");
            setLoading(true);

            const handler = window.PaystackPop.setup({
              key: PAYSTACK_PUBLIC_KEY,
              email,
              amount: Math.round(amt * 100), // minor units
              currency,
              ref: `SI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              callback: (r) => {
                (async () => {
                  try {
                    await credit({ data: { amount: amt, currency, reference: r.reference } });
                    toast.success(`Deposit successful — ${currency} ${amt.toFixed(2)} credited.`);
                    await qc.invalidateQueries();
                    onOpenChange(false);
                  } catch (err: any) {
                    toast.error(err.message);
                  } finally {
                    setLoading(false);
                  }
                })();
              },
              onClose: () => {
                setLoading(false);
                toast.info("Payment window closed.");
              },
            });
            handler.openIframe();
          }}
        >
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{CURRENCY_META[c].symbol} {c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="amt">Amount</Label>
              <Input id="amt" type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <Button type="submit" className="w-full gradient-brand text-white" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Pay with Paystack
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Test mode. Use Paystack test cards (e.g. 4084 0840 8408 4081).
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}