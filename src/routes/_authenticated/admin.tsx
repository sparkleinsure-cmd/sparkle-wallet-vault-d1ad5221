import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "@/lib/wallet.functions";
import { adminLookupUser, adminCreditBonus, adminSeedDemo } from "@/lib/admin.functions";
import { AppHeader } from "@/components/Header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CURRENCIES, CURRENCY_META, formatMoney, type Currency } from "@/lib/currency";
import { Loader2, Search, Sparkles, Database } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin — Sparkle Insure" }, { name: "robots", content: "noindex" }] }),
  component: AdminPage,
});

function AdminPage() {
  const fetchMe = useServerFn(getMe);
  const lookup = useServerFn(adminLookupUser);
  const credit = useServerFn(adminCreditBonus);
  const seed = useServerFn(adminSeedDemo);
  const navigate = useNavigate();

  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: () => fetchMe() });

  useEffect(() => {
    if (me && !me.roles.includes("admin")) navigate({ to: "/dashboard" });
  }, [me, navigate]);

  const [accountId, setAccountId] = useState("");
  const [target, setTarget] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("ZAR");
  const [note, setNote] = useState("");

  if (isLoading || !me) return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="min-h-screen">
      <AppHeader isAdmin accountId={me.profile?.account_id} />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6 md:py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold">Admin Console</h1>
            <p className="text-sm text-muted-foreground">Restricted access · authorized personnel only.</p>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const r = await seed();
                toast.success(r.seeded ? `Seeded ${r.seeded} demo users` : "Demo data already present");
              } catch (e: any) { toast.error(e.message); }
            }}
          >
            <Database className="mr-2 h-4 w-4" /> Seed demo users
          </Button>
        </div>

        <Card className="glass-card rounded-2xl p-6">
          <h2 className="mb-4 font-display text-lg font-semibold">Lookup by Account ID</h2>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!accountId.trim()) return;
              setLoading(true);
              try {
                const r = await lookup({ data: { accountId: accountId.trim() } });
                setTarget(r);
                if (!r.profile) toast.error("No account with that ID");
              } catch (err: any) { toast.error(err.message); }
              finally { setLoading(false); }
            }}
          >
            <Input
              placeholder="e.g. K7DP2X9M"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value.toUpperCase())}
              className="font-mono uppercase"
            />
            <Button type="submit" disabled={loading} className="gradient-brand text-white">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </form>
        </Card>

        {target?.profile && (
          <Card className="glass-card space-y-6 rounded-2xl p-6">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Account holder</div>
              <div className="mt-1 font-display text-2xl font-bold">
                {target.profile.first_name} {target.profile.surname}
              </div>
              <div className="text-sm text-muted-foreground">
                {target.profile.email} · {target.profile.phone} · ID {target.profile.account_id}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              {CURRENCIES.map((c) => {
                const w = target.wallets.find((x: any) => x.currency === c);
                return (
                  <div key={c} className="rounded-xl border border-border/60 bg-background/40 p-3">
                    <div className="text-[10px] uppercase text-muted-foreground">{CURRENCY_META[c].name}</div>
                    <div className="font-display text-lg font-semibold">{formatMoney(Number(w?.balance ?? 0), c)}</div>
                  </div>
                );
              })}
            </div>

            <form
              className="grid gap-3 md:grid-cols-[1fr_140px_2fr_auto]"
              onSubmit={async (e) => {
                e.preventDefault();
                const amt = Number(amount);
                if (!isFinite(amt) || amt <= 0) return toast.error("Enter a valid amount");
                setLoading(true);
                try {
                  await credit({ data: { accountId: target.profile.account_id, currency, amount: amt, note: note || undefined } });
                  toast.success(`Credited ${formatMoney(amt, currency)} to ${target.profile.account_id}`);
                  const r = await lookup({ data: { accountId: target.profile.account_id } });
                  setTarget(r);
                  setAmount(""); setNote("");
                } catch (err: any) { toast.error(err.message); }
                finally { setLoading(false); }
              }}
            >
              <div>
                <Label>Amount</Label>
                <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Note</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / description" />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={loading} className="gradient-accent text-white">
                  <Sparkles className="mr-2 h-4 w-4" /> Credit
                </Button>
              </div>
            </form>
          </Card>
        )}
      </main>
    </div>
  );
}