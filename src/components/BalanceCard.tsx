import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { ArrowDownToLine, ArrowUpFromLine, FileText } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function BalanceCard({
  balance,
  currency,
  onCurrencyChange,
  onDeposit,
  onWithdraw,
  onStatement,
  accountId,
}: {
  balance: number;
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onStatement: () => void;
  accountId: string;
}) {
  return (
    <div className="glass-card relative overflow-hidden rounded-3xl p-6 md:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full gradient-brand opacity-30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full gradient-accent opacity-20 blur-3xl" />
      <div className="relative">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Available balance</div>
            <div className="mt-2 flex items-end gap-3">
              <div className="font-display text-4xl font-bold md:text-5xl">
                {formatMoney(balance, currency)}
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {CURRENCY_META[currency].name} · Account {accountId}
            </div>
          </div>
          <Select value={currency} onValueChange={(v) => onCurrencyChange(v as Currency)}>
            <SelectTrigger className="w-28 bg-background/70">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CURRENCY_META[c].symbol} {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-8 grid grid-cols-3 gap-3">
          <Button onClick={onDeposit} className="h-12 gradient-brand text-white shadow-md">
            <ArrowDownToLine className="mr-2 h-4 w-4" /> Deposit
          </Button>
          <Button onClick={onWithdraw} variant="secondary" className="h-12">
            <ArrowUpFromLine className="mr-2 h-4 w-4" /> Withdraw
          </Button>
          <Button onClick={onStatement} variant="outline" className="h-12">
            <FileText className="mr-2 h-4 w-4" /> Statement
          </Button>
        </div>
      </div>
    </div>
  );
}