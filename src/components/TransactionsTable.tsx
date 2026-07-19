import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, type Currency } from "@/lib/currency";
import { format } from "date-fns";
import { ArrowDownToLine, ArrowUpFromLine, CircleDollarSign, Sparkles, Search } from "lucide-react";

type Tx = {
  id: string;
  type: string;
  currency: string;
  amount: number;
  status: string;
  description: string | null;
  created_at: string;
};

export function TransactionsTable({ transactions }: { transactions: Tx[] }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      const matchesType = type === "all" || t.type === type;
      const s = q.trim().toLowerCase();
      const matchesQ = !s ||
        (t.description ?? "").toLowerCase().includes(s) ||
        t.currency.toLowerCase().includes(s) ||
        String(t.amount).includes(s);
      return matchesType && matchesQ;
    });
  }, [transactions, q, type]);

  return (
    <div className="glass-card rounded-3xl p-4 md:p-6">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h2 className="font-display text-lg font-semibold">Recent activity</h2>
        <div className="flex flex-1 gap-2 md:max-w-md">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search transactions..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="deposit">Deposits</SelectItem>
              <SelectItem value="withdrawal">Withdrawals</SelectItem>
              <SelectItem value="fee">Penalty fees</SelectItem>
              <SelectItem value="bonus">Bonuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="divide-y divide-border/50">
        {filtered.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">No transactions found.</div>
        )}
        {filtered.map((t) => {
          const isDebit = t.type === "withdrawal" || t.type === "fee";
          const Icon = t.type === "deposit" ? ArrowDownToLine : t.type === "withdrawal" ? ArrowUpFromLine : t.type === "fee" ? CircleDollarSign : Sparkles;
          const sign = isDebit ? "-" : "+";
          const color = isDebit ? "text-rose-600" : "text-emerald-600";
          if (t.type === "bonus" && (t.description ?? "").startsWith("Account top up")) {
            t.status = "Topped up";
          }
          const statusLabel = t.type === "deposit" && t.status === "pending" ? "Topped up" : t.status;
          return (
            <div key={t.id} className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-muted ${color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-medium">{t.description ?? t.type}</div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(t.created_at), "d MMM yyyy · HH:mm")} · {statusLabel}
                  </div>
                </div>
              </div>
              <div className={`font-semibold tabular-nums ${color}`}>
                {sign}
                {formatMoney(Number(t.amount), t.currency as Currency)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
