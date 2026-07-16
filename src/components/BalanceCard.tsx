import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { ArrowDownToLine, ArrowUpFromLine, FileText, ChevronDown, ChevronUp, Clock, CheckCircle2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUsdToZarRate, convertTotal } from "@/lib/exchange-rate";
import { useState } from "react";

type Tranche = {
  id: string;
  currency: string;
  amount: number;
  remaining: number;
  current_balance?: number;
  status?: string;
  source: string;
  created_at: string;
  maturity_date: string;
};

export function BalanceCard({
  zarBalance,
  usdBalance,
  currency,
  onCurrencyChange,
  onDeposit,
  onWithdraw,
  onStatement,
  accountId,
  tranches,
}: {
  zarBalance: number;
  usdBalance: number;
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onStatement: () => void;
  accountId: string;
  tranches: Tranche[];
}) {
  const { data: usdToZar = 18.5 } = useUsdToZarRate();
  const now = Date.now();

  // Locked (still-running) tranches: use remaining for withdrawable math,
  // and current_balance (initial + daily incentives) for the growing display.
  const isLocked = (t: Tranche) =>
    (t.status ?? (new Date(t.maturity_date).getTime() > now ? "locked" : "matured")) === "locked" &&
    new Date(t.maturity_date).getTime() > now;
  const lockedRemainingZar = tranches.filter((t) => t.currency === "ZAR" && isLocked(t)).reduce((s, t) => s + Number(t.remaining), 0);
  const lockedRemainingUsd = tranches.filter((t) => t.currency === "USD" && isLocked(t)).reduce((s, t) => s + Number(t.remaining), 0);
  const growingZar = tranches.filter((t) => t.currency === "ZAR" && isLocked(t)).reduce((s, t) => s + Number(t.current_balance ?? t.remaining), 0);
  const growingUsd = tranches.filter((t) => t.currency === "USD" && isLocked(t)).reduce((s, t) => s + Number(t.current_balance ?? t.remaining), 0);
  const withdrawableZar = Math.max(0, zarBalance - lockedRemainingZar);
  const withdrawableUsd = Math.max(0, usdBalance - lockedRemainingUsd);

  const total = convertTotal(zarBalance + (growingZar - lockedRemainingZar), usdBalance + (growingUsd - lockedRemainingUsd), usdToZar, currency);
  const withdrawable = convertTotal(withdrawableZar, withdrawableUsd, usdToZar, currency);
  const locked = convertTotal(growingZar, growingUsd, usdToZar, currency);

  // A cycle is only "active" if it still has principal remaining
  const activeTranches = tranches.filter((t) => Number(t.remaining) > 0.01).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return (
    <div className="glass-card relative overflow-hidden rounded-3xl p-6 md:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full gradient-brand opacity-30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full gradient-accent opacity-20 blur-3xl" />
      <div className="relative">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Total value</div>
            <div className="mt-1 font-display text-3xl font-bold md:text-4xl">
              {formatMoney(total, currency)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              1 USD = {usdToZar.toFixed(2)} ZAR · Account {accountId}
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

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> Withdrawable
            </div>
            <div className="mt-1 font-display text-2xl font-bold">
              {formatMoney(withdrawable, currency)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Matured funds + instant bonuses</div>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-amber-700 dark:text-amber-300">
              <Clock className="h-3 w-3" /> Current (growing)
            </div>
            <div className="mt-1 font-display text-2xl font-bold">
              {formatMoney(locked, currency)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Active 30-day cycles</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowCycles((v) => !v)}
          className="mt-4 flex w-full items-center justify-between rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-sm hover:bg-muted/40"
        >
          <span className="font-medium">View Active Cycles ({activeTranches.length})</span>
          {showCycles ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {showCycles && (
          <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
            {activeTranches.length === 0 && (
              <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                No active cycles yet — your deposits will appear here.
              </div>
            )}
            {activeTranches.map((t) => {
              const ms = new Date(t.maturity_date).getTime() - now;
              const days = Math.ceil(ms / 864e5);
              const matured = ms <= 0;
              const cur = Number(t.current_balance ?? t.remaining);
              const init = Number(t.amount);
              return (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/60 p-3 text-sm">
                  <div>
                    <div className="font-semibold">
                      {formatMoney(cur, t.currency as Currency)}
                      {cur !== init && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          from {formatMoney(init, t.currency as Currency)}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t.source === "bonus" ? "Bonus" : "Deposit"} · {new Date(t.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className={`text-xs font-medium ${matured ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {matured ? "Matured" : `Matures in ${days}d`}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-5 grid grid-cols-3 gap-3">
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