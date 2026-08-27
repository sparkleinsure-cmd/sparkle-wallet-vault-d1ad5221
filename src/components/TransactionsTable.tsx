import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMoney, type Currency } from "@/lib/currency";
import { format } from "date-fns";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, CircleDollarSign, Sparkles, Search } from "lucide-react";

type Tx = {
  id: string;
  type: string;
  currency: string;
  amount: number;
  status: string;
  description: string | null;
  reference?: string | null;
  created_at: string;
};

export function TransactionsTable({ transactions }: { transactions: Tx[] }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");
  const [selected, setSelected] = useState<Tx | null>(null);

  const filtered = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return transactions.filter((t) => {
      if (new Date(t.created_at).getTime() < sevenDaysAgo) return false;
      const matchesType = type === "all" || t.type === type;
      const s = q.trim().toLowerCase();
      const matchesQ =
        !s ||
        (t.description ?? "").toLowerCase().includes(s) ||
        t.currency.toLowerCase().includes(s) ||
        String(t.amount).includes(s);
      return matchesType && matchesQ;
    });
  }, [transactions, q, type]);

  return (
    <div className="glass-card rounded-3xl p-4 md:p-6">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Recent activity</h2>
          <p className="text-xs text-muted-foreground">Last 7 days</p>
        </div>
        <div className="flex flex-1 gap-2 md:max-w-md">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search transactions..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="deposit">Deposits</SelectItem>
              <SelectItem value="withdrawal">Withdrawals</SelectItem>
              <SelectItem value="transfer">Transfers</SelectItem>
              <SelectItem value="fee">Penalty fees</SelectItem>
              <SelectItem value="bonus">Bonuses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="max-h-[216px] divide-y divide-border/50 overflow-y-auto pr-1">
        {filtered.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No transactions found.
          </div>
        )}
        {filtered.map((t) => {
          const isTransfer = t.type === "transfer";
          const isDebit = t.type === "withdrawal" || t.type === "fee" || Number(t.amount) < 0;
          const Icon =
            t.type === "deposit"
              ? ArrowDownToLine
              : t.type === "withdrawal"
                ? ArrowUpFromLine
                : isTransfer
                  ? ArrowLeftRight
                : t.type === "fee"
                  ? CircleDollarSign
                  : Sparkles;
          const sign = isTransfer ? "" : isDebit ? "-" : "+";
          const color = isTransfer ? "text-sky-600" : isDebit ? "text-rose-600" : "text-emerald-600";
          const statusLabel = transactionStatus(t);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t)}
              className="flex min-h-[72px] w-full items-center justify-between gap-3 rounded-lg px-1 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl bg-muted ${color}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-medium">{t.description ?? t.type}</div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(t.created_at), "d MMM yyyy · HH:mm")} · {statusLabel}
                  </div>
                </div>
              </div>
              <div className={`shrink-0 font-semibold tabular-nums ${color}`}>
                {sign}
                {formatMoney(Math.abs(Number(t.amount)), t.currency as Currency)}
              </div>
            </button>
          );
        })}
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          {selected && <TransactionDetails transaction={selected} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function transactionStatus(transaction: Tx) {
  if (
    transaction.type === "bonus" &&
    (transaction.description ?? "").startsWith("Account top up")
  ) {
    return "Topped up";
  }
  return transaction.type === "deposit" && transaction.status === "pending"
    ? "Topped up"
    : transaction.status;
}

function TransactionDetails({ transaction }: { transaction: Tx }) {
  const isTransfer = transaction.type === "transfer";
  const isDebit =
    transaction.type === "withdrawal" ||
    transaction.type === "fee" ||
    Number(transaction.amount) < 0;
  const status = transactionStatus(transaction);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Transaction details</DialogTitle>
        <DialogDescription>Complete information for this wallet transaction.</DialogDescription>
      </DialogHeader>
      <div className="mt-2 rounded-2xl border bg-muted/30 p-4">
        <div
          className={`text-2xl font-bold tabular-nums ${isTransfer ? "text-sky-600" : isDebit ? "text-rose-600" : "text-emerald-600"}`}
        >
          {isTransfer ? "" : isDebit ? "-" : "+"}
          {formatMoney(Math.abs(Number(transaction.amount)), transaction.currency as Currency)}
        </div>
        <div className="mt-1 text-sm font-medium">
          {transaction.description ?? transaction.type}
        </div>
      </div>
      <dl className="divide-y divide-border/60 text-sm">
        <Detail label="Type" value={transaction.type} capitalize />
        <Detail label="Status" value={status} capitalize />
        <Detail label="Date" value={format(new Date(transaction.created_at), "d MMMM yyyy")} />
        <Detail label="Time" value={format(new Date(transaction.created_at), "HH:mm:ss")} />
        <Detail label="Currency" value={transaction.currency} />
        {transaction.reference && <Detail label="Reference" value={transaction.reference} />}
        <Detail label="Transaction ID" value={transaction.id} breakAll />
      </dl>
    </>
  );
}

function Detail({
  label,
  value,
  capitalize,
  breakAll,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
  breakAll?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`text-right font-medium ${capitalize ? "capitalize" : ""} ${breakAll ? "max-w-[65%] break-all" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
