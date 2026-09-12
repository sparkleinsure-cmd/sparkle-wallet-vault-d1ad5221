import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { sendFunds } from "@/lib/app-api";
import { CURRENCIES, formatMoney, type Currency } from "@/lib/currency";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function SendFundsDialog({
  open,
  onOpenChange,
  defaultCurrency,
  withdrawable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCurrency: Currency;
  withdrawable: Record<Currency, number>;
}) {
  const [recipient, setRecipient] = useState("");
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState<{
    status: "pending" | "completed";
    name: string;
    accountId: string;
    amount: number;
    currency: Currency;
  } | null>(null);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const queryClient = useQueryClient();

  const reset = () => {
    setRecipient("");
    setCurrency(defaultCurrency);
    setAmount("");
    setCompleted(null);
    setLoading(false);
    requestRef.current = null;
  };

  const submit = async () => {
    const normalizedRecipient = recipient.trim();
    const value = Number(amount);
    if (normalizedRecipient.length < 3) {
      return toast.error("Enter the recipient's User ID or registered phone number.");
    }
    if (!Number.isFinite(value) || value < 0.01) {
      return toast.error("Enter a valid amount to send.");
    }
    if (value > withdrawable[currency]) {
      return toast.error(`Only ${formatMoney(withdrawable[currency], currency)} is withdrawable.`);
    }
    if (!window.confirm(`Send ${formatMoney(value, currency)} to ${normalizedRecipient}?`)) return;

    const requestKey = `${normalizedRecipient.toUpperCase()}:${currency}:${value.toFixed(2)}`;
    if (requestRef.current?.key !== requestKey) {
      requestRef.current = { key: requestKey, id: crypto.randomUUID() };
    }

    setLoading(true);
    try {
      const result = await sendFunds({
        data: {
          recipient: normalizedRecipient,
          currency,
          amount: value,
          requestId: requestRef.current.id,
        },
      });
      setCompleted({
        status: result.status,
        name: result.recipientName,
        accountId: result.recipientAccountId,
        amount: Number(result.amount),
        currency: result.currency,
      });
      if (result.status === "pending") {
        toast.success("Transfer submitted for administrator approval.");
      } else {
        toast.success(
          `${formatMoney(Number(result.amount), result.currency)} sent to ${result.recipientName}.`,
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["me"] }),
          queryClient.invalidateQueries({ queryKey: ["account-health"] }),
        ]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send funds.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send funds</DialogTitle>
          <DialogDescription>
            Transfer withdrawable funds to another Sparkle Insure member.
          </DialogDescription>
        </DialogHeader>

        {completed ? (
          <div className="space-y-4">
            <div
              className={`rounded-xl border p-4 text-sm ${completed.status === "pending" ? "border-amber-500/30 bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/10"}`}
            >
              <div
                className={`flex items-center gap-2 font-semibold ${completed.status === "pending" ? "text-amber-800 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}
              >
                <Send className="h-4 w-4" />{" "}
                {completed.status === "pending"
                  ? "Awaiting administrator approval"
                  : "Transfer completed"}
              </div>
              <p className="mt-2">
                {formatMoney(completed.amount, completed.currency)}{" "}
                {completed.status === "pending" ? "will be sent after approval" : "was sent"} to{" "}
                {completed.name} ({completed.accountId}).
              </p>
              {completed.status === "pending" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  No funds have been deducted while this request is pending.
                </p>
              )}
            </div>
            <Button
              className="w-full"
              type="button"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="transfer-recipient">User ID or registered phone number</Label>
              <Input
                id="transfer-recipient"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="e.g. 7S0UMZUK or +27 82 123 4567"
                maxLength={50}
                autoComplete="off"
              />
            </div>
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <div>
                <Label htmlFor="transfer-currency">Currency</Label>
                <Select value={currency} onValueChange={(value) => setCurrency(value as Currency)}>
                  <SelectTrigger id="transfer-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="transfer-amount">Amount</Label>
                <Input
                  id="transfer-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  max={withdrawable[currency]}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Available to send: {formatMoney(withdrawable[currency], currency)}. Active growing
              funds cannot be transferred.
            </p>
            <Button
              type="button"
              className="w-full gradient-brand text-white"
              disabled={loading || withdrawable[currency] < 0.01}
              onClick={submit}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {loading ? "Sending…" : "Send funds"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
