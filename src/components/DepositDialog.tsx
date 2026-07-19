import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, CURRENCY_META, type Currency } from "@/lib/currency";
import { useState } from "react";
import { toast } from "sonner";
import { creditDeposit } from "@/lib/app-api";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Copy, Upload } from "lucide-react";

const BANK = {
  name: "FNB (First National Bank)",
  account: "6264854525",
  branch: "250655",
};

export function DepositDialog({
  open,
  onOpenChange,
  defaultCurrency,
  accountId,
  userId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultCurrency: Currency;
  accountId: string;
  userId: string;
}) {
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const credit = creditDeposit;
  const qc = useQueryClient();

  const reference = accountId;
  const copy = (v: string, label: string) => {
    navigator.clipboard.writeText(v);
    toast.success(`${label} copied`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deposit to your wallet</DialogTitle>
          <DialogDescription>
            Make an EFT/bank deposit to the account below, then upload your proof of payment.
            Your deposit will appear as pending until an administrator verifies that the funds have cleared.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-4 text-sm">
          <Row label="Bank" value={BANK.name} />
          <Row label="Account number" value={BANK.account} onCopy={() => copy(BANK.account, "Account number")} />
          <Row label="Branch code" value={BANK.branch} onCopy={() => copy(BANK.branch, "Branch code")} />
          <Row label="Reference" value={reference} onCopy={() => copy(reference, "Reference")} highlight />
        </div>

        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          <strong>Please use an immediate payment.</strong> Deposits remain pending until an administrator
          confirms that funds have cleared into our
          bank account. Your 30-day growth cycle starts on the approval date — e.g. if you deposit on
          the 12th and the admin approves on the 13th, your start date will be the 13th, not the 12th.
        </div>

        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const amt = Number(amount);
            if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
            if (!file) return toast.error("Please upload your proof of payment");
            if (file.size > 10 * 1024 * 1024) return toast.error("File must be under 10MB");
            setLoading(true);
            try {
              const ref = `POP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const ext = file.name.split(".").pop() || "bin";
              const path = `${userId}/${ref}.${ext}`;
              const up = await supabase.storage.from("deposits").upload(path, file, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
              });
              if (up.error) throw up.error;
              await credit({ data: { amount: amt, currency, reference: ref, proofUrl: path } });
              toast.success(`Deposit submitted — ${currency} ${amt.toFixed(2)} is pending administrator verification.`);
              await qc.invalidateQueries();
              setAmount(""); setFile(null);
              onOpenChange(false);
            } catch (err: any) {
              toast.error(err.message ?? "Upload failed");
            } finally {
              setLoading(false);
            }
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
              <Label htmlFor="amt">Amount deposited</Label>
              <Input id="amt" type="number" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>

          <div>
            <Label htmlFor="pop">Proof of payment (image or PDF)</Label>
            <label htmlFor="pop" className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-background/40 p-4 text-sm text-muted-foreground hover:bg-muted/40">
              <Upload className="h-4 w-4" />
              {file ? file.name : "Click to select receipt (max 10MB)"}
            </label>
            <input
              id="pop"
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <Button type="submit" className="w-full gradient-brand text-white" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Submit deposit
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Pending deposits are not available to withdraw and do not begin a growth cycle until approved.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, onCopy, highlight }: { label: string; value: string; onCopy?: () => void; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`font-mono ${highlight ? "font-bold text-primary" : ""}`}>{value}</span>
        {onCopy && (
          <button type="button" onClick={onCopy} className="rounded p-1 hover:bg-muted">
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
