import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Award, HeartPulse, TrendingDown, TrendingUp } from "lucide-react";
import { formatMoney } from "@/lib/currency";

type Snapshot = {
  snapshot_date: string;
  withdrawable_zar: number | string;
  wallet_health: number | string;
  daily_top_ups: number | string;
  withdrawals: number | string;
  penalties: number | string;
  reward_credit: number | string;
};

function dayLabel(date: string) {
  return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short" }).format(new Date(`${date}T00:00:00`));
}

export function AccountHealthCard({ health, currentWithdrawable }: { health: any; currentWithdrawable: number }) {
  const snapshots = (health?.snapshots ?? []) as Snapshot[];
  const data = snapshots.map((snapshot) => ({
    date: dayLabel(snapshot.snapshot_date),
    withdrawable: Number(snapshot.withdrawable_zar),
    topUps: Number(snapshot.daily_top_ups),
    withdrawals: Number(snapshot.withdrawals),
    penalties: Number(snapshot.penalties),
    reward: Number(snapshot.reward_credit),
  }));
  const healthScore = snapshots.length ? Number(snapshots.at(-1)?.wallet_health ?? 0) : Math.min(100, Math.round((currentWithdrawable / 2000) * 100));
  const streakDays = Number(health?.streakDays ?? 0);
  const points = Number(health?.points ?? 0);
  const progress = Math.min(100, (streakDays % 30) / 30 * 100);
  const nextRewardDays = streakDays >= 30 ? 30 - (streakDays % 30 || 30) : 30 - streakDays;

  return (
    <section className="glass-card relative overflow-hidden rounded-3xl p-5 md:p-6">
      <div className="pointer-events-none absolute -right-12 top-0 h-36 w-36 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground"><Activity className="h-3.5 w-3.5 text-primary" /> 30-day wallet health</div>
            <h2 className="mt-1 font-display text-xl font-bold">Your account, in motion</h2>
          </div>
          <div className="rounded-2xl border border-primary/20 bg-primary/10 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-primary">Health</div>
            <div className="font-display text-lg font-bold text-primary">{healthScore}%</div>
          </div>
        </div>

        <div className="mt-4 h-40">
          {data.length >= 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 6, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="healthFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#0b8198" stopOpacity={0.35} /><stop offset="100%" stopColor="#0b8198" stopOpacity={0.02} /></linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis hide domain={["dataMin - 100", "dataMax + 100"]} />
                <Tooltip contentStyle={{ borderRadius: 14, border: "1px solid rgba(11,129,152,.2)", background: "rgba(255,255,255,.96)" }} formatter={(value: number) => [formatMoney(value, "ZAR"), "Withdrawable"]} />
                <Area type="monotone" dataKey="withdrawable" stroke="#0b8198" strokeWidth={3} fill="url(#healthFill)" dot={{ r: 5, fill: "#0b8198", strokeWidth: 0 }} activeDot={{ r: 6 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-primary/20 bg-primary/5 px-5 text-center text-sm text-muted-foreground">Your live wallet activity will appear here as transactions are completed.</div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-xl bg-emerald-500/10 p-2"><TrendingUp className="mb-1 h-3.5 w-3.5 text-emerald-600" /><span className="block text-muted-foreground">Top ups</span><strong>{formatMoney(data.reduce((sum, d) => sum + d.topUps, 0), "ZAR")}</strong></div>
          <div className="rounded-xl bg-rose-500/10 p-2"><TrendingDown className="mb-1 h-3.5 w-3.5 text-rose-600" /><span className="block text-muted-foreground">Withdrawn</span><strong>{formatMoney(data.reduce((sum, d) => sum + d.withdrawals, 0), "ZAR")}</strong></div>
          <div className="rounded-xl bg-amber-500/10 p-2"><HeartPulse className="mb-1 h-3.5 w-3.5 text-amber-600" /><span className="block text-muted-foreground">Penalties</span><strong>{formatMoney(data.reduce((sum, d) => sum + d.penalties, 0), "ZAR")}</strong></div>
        </div>

        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-gradient-to-r from-amber-500/10 via-background to-primary/10 p-4">
          <div className="flex items-center justify-between gap-3"><div><div className="flex items-center gap-1.5 font-display font-bold"><Award className="h-4 w-4 text-amber-600" /> Wallet health rewards</div><p className="mt-0.5 text-xs text-muted-foreground">Hold R2,000+ withdrawable for 30 days to earn an instant R9.99 credit.</p></div><div className="text-right"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Points earned</div><div className="font-display text-2xl font-bold text-amber-700 dark:text-amber-300">{points}</div></div></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-primary transition-all" style={{ width: `${progress}%` }} /></div>
          <div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>{streakDays % 30} / 30 qualifying days</span><span>{nextRewardDays === 0 ? "Reward due at the next daily check" : `${nextRewardDays} days to R9.99`}</span></div>
        </div>
      </div>
    </section>
  );
}
