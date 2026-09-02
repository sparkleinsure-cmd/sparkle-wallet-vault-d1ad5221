import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Upload } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { creditDeposit } from "@/lib/app-api";
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

const BANK = {
  name: "FNB (First National Bank)",
  account: "63224867101",
  branch: "250205",
};

export function DepositDialog({
  open,
  onOpenChange,
  accountId,
  userId,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  accountId: string;
  userId: string;
}) {
  const [cycleCode, setCycleCode] = useState<GrowthCycleCode>("15d");
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const submissionRef = useRef<{ key: string; reference: string } | null>(null);
  const queryClient = useQueryClient();

  const cycle = getGrowthCycle(cycleCode);
  const amountValue = Number(amount);
  const amountError = amount ? validateCycleAmount(amountValue, cycle) : null;
  const expectedAmount = amount && !amountError ? expectedCycleAmount(amountValue, cycle) : null;
  const estimatedDate = estimatedMaturityDate(cycle.termDays);
  const reference = accountId;

  const copy = (value: string, label: string) => {
    void navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deposit to your wallet</DialogTitle>
          <DialogDescription>
            Choose a growth cycle, make an EFT to the account below, then upload your proof of
            payment. Your deposit remains pending until an administrator confirms the funds have
            cleared.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-4 text-sm">
          <Row label="Bank" value={BANK.name} />
          <Row
            label="Account number"
            value={BANK.account}
            onCopy={() => copy(BANK.account, "Account number")}
          />
          <Row
            label="Branch code"
            value={BANK.branch}
            onCopy={() => copy(BANK.branch, "Branch code")}
          />
          <Row
            label="Reference"
            value={reference}
            onCopy={() => copy(reference, "Reference")}
            highlight
          />
        </div>

        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          <strong>Please use an immediate payment.</strong> Your selected growth cycle starts only
          when the administrator approves the cleared funds. The maturity date shown below is an
          estimate based on approval today.
        </div>

        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const validationError = validateCycleAmount(amountValue, cycle);
            if (validationError) return toast.error(validationError);
            if (!file) return toast.error("Please upload your proof of payment");
            if (file.size > 10 * 1024 * 1024) return toast.error("File must be under 10MB");

            setLoading(true);
            try {
              const submissionKey = `ZAR:${cycleCode}:${amountValue.toFixed(2)}:${file.name}:${file.size}:${file.lastModified}`;
              if (submissionRef.current?.key !== submissionKey) {
                submissionRef.current = {
                  key: submissionKey,
                  reference: `POP-${crypto.randomUUID()}`,
                };
              }
              const depositReference = submissionRef.current.reference;
              const extension = file.name.split(".").pop() || "bin";
              const path = `${userId}/${depositReference}.${extension}`;
              const upload = await supabase.storage.from("deposits").upload(path, file, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
              });
              const uploadStatus = (upload.error as { statusCode?: string | number } | null)
                ?.statusCode;
              const duplicateUpload =
                upload.error &&
                (String(uploadStatus) === "409" ||
                  /already exists|duplicate/i.test(upload.error.message));
              if (upload.error && !duplicateUpload) throw upload.error;

              await creditDeposit({
                data: {
                  amount: amountValue,
                  currency: "ZAR",
                  cycleCode,
                  reference: depositReference,
                  proofUrl: path,
                },
              });
              toast.success(
                `${formatMoney(amountValue, "ZAR")} submitted for the ${cycle.label} cycle and is pending verification.`,
              );
              await queryClient.invalidateQueries();
              setAmount("");
              setFile(null);
              submissionRef.current = null;
              onOpenChange(false);
            } catch (error: unknown) {
              toast.error(error instanceof Error ? error.message : "Upload failed");
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
            <Label htmlFor="deposit-amount">Amount deposited (ZAR)</Label>
            <Input
              id="deposit-amount"
              type="number"
              min={cycle.minAmount}
              max={cycle.maxAmount}
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
              Lock {formatMoney(amountValue, "ZAR")} for {cycle.shortLabel}. If approved today, the
              estimated maturity date is {formatCycleDate(estimatedDate)}. Expected withdrawable
              amount: <strong>{formatMoney(expectedAmount, "ZAR")}</strong>.
            </div>
          )}

          <div>
            <Label htmlFor="proof-of-payment">Proof of payment (image or PDF)</Label>
            <label
              htmlFor="proof-of-payment"
              className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-background/40 p-4 text-sm text-muted-foreground hover:bg-muted/40"
            >
              <Upload className="h-4 w-4" />
              {file ? file.name : "Click to select receipt (max 10MB)"}
            </label>
            <input
              id="proof-of-payment"
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <Button
            type="submit"
            className="w-full gradient-brand text-white"
            disabled={loading || Boolean(amountError)}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Submit deposit
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Pending deposits are not withdrawable and do not begin growing until approved.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  onCopy,
  highlight,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  highlight?: boolean;
}) {
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
