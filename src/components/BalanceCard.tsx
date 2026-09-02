import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { ArrowRight, ChevronDown, ChevronUp, Clock, CheckCircle2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useUsdToZarRate, convertTotal } from "@/lib/exchange-rate";
import { useState } from "react";
import { formatCycleDate } from "@/lib/growth-cycles";

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
  cycle_label?: string | null;
  term_days?: number | null;
  target_gain?: number | null;
};

export function BalanceCard({
  zarBalance,
  usdBalance,
  currency,
  onCurrencyChange,
  tranches,
  onMoveToGrowing,
  moveToGrowingDisabled = false,
}: {
  zarBalance: number;
  usdBalance: number;
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  tranches: Tranche[];
  onMoveToGrowing: () => void;
  moveToGrowingDisabled?: boolean;
}) {
  const { data: usdToZar = 18.5 } = useUsdToZarRate();
  const now = Date.now();

  // Locked (still-running) tranches: use remaining for withdrawable math,
  // and current_balance (initial + daily incentives) for the growing display.
  const isLocked = (t: Tranche) =>
    (t.status ?? (new Date(t.maturity_date).getTime() > now ? "locked" : "matured")) === "locked";
  const lockedRemainingZar = tranches.filter((t) => t.currency === "ZAR" && isLocked(t)).reduce((s, t) => s + Number(t.remaining), 0);
  const lockedRemainingUsd = tranches.filter((t) => t.currency === "USD" && isLocked(t)).reduce((s, t) => s + Number(t.remaining), 0);
  const growingZar = tranches.filter((t) => t.currency === "ZAR" && isLocked(t)).reduce((s, t) => s + Number(t.current_balance ?? t.remaining), 0);
  const growingUsd = tranches.filter((t) => t.currency === "USD" && isLocked(t)).reduce((s, t) => s + Number(t.current_balance ?? t.remaining), 0);
  const withdrawableZar = Math.max(0, zarBalance - lockedRemainingZar);
  const withdrawableUsd = Math.max(0, usdBalance - lockedRemainingUsd);

  const withdrawable = convertTotal(withdrawableZar, withdrawableUsd, usdToZar, currency);
  const growing = convertTotal(growingZar, growingUsd, usdToZar, currency);
  // Portfolio always includes both liquid funds and the live value of every
  // still-growing cycle. Keeping this as an explicit sum prevents a wallet
  // ledger value from masking earned growth or available matured funds.
  const total = withdrawable + growing;
  const [showCycles, setShowCycles] = useState(false);
  const activeTranches = tranches.filter((t) => isLocked(t) && Number(t.remaining) > 0).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return (
    <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-card p-5 shadow-[var(--shadow-glass)] md:p-8">
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Portfolio</div>
            <div className="mt-1 whitespace-nowrap font-display text-[clamp(1.625rem,7vw,2.25rem)] font-bold leading-tight tracking-[-0.035em] tabular-nums">
              {formatMoney(total, currency)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Total balance · 1 USD = {usdToZar.toFixed(2)} ZAR
            </div>
          </div>
          <Select value={currency} onValueChange={(v) => onCurrencyChange(v as Currency)}>
            <SelectTrigger className="w-28 shrink-0 bg-background/70">
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
            <div className="mt-1 whitespace-nowrap font-display text-[clamp(1rem,5vw,1.25rem)] font-bold leading-tight tracking-[-0.035em] tabular-nums">
              {formatMoney(withdrawable, currency)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Matured funds + instant bonuses</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full justify-between gap-1 bg-background/60 px-2.5"
              onClick={onMoveToGrowing}
              disabled={moveToGrowingDisabled}
              aria-label="Move withdrawable funds to growing balance"
            >
              <span className="sm:hidden">Grow funds</span>
              <span className="hidden sm:inline">Move to growing</span>
              <ArrowRight className="shrink-0" />
            </Button>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-amber-700 dark:text-amber-300">
              <Clock className="h-3 w-3" /> Current (growing)
            </div>
            <div className="mt-1 whitespace-nowrap font-display text-[clamp(1rem,5vw,1.25rem)] font-bold leading-tight tracking-[-0.035em] tabular-nums">
              {formatMoney(growing, currency)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Active selected cycles</div>
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
              const expected = t.target_gain == null ? null : init + Number(t.target_gain);
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
                      {t.source === "transfer" ? "Moved to growing" : t.source === "referral" ? "Referral reward" : t.source === "bonus" ? "Bonus" : "Deposit"} · {new Date(t.created_at).toLocaleDateString()}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t.cycle_label ?? (t.term_days ? `${t.term_days} days` : "Growth cycle")} · Matures {formatCycleDate(t.maturity_date)}
                      {expected !== null ? ` · Expected ${formatMoney(expected, t.currency as Currency)}` : ""}
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

      </div>
    </div>
  );
}
