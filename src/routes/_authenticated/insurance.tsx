import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, Clock3, Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getInsuranceDashboard, getMe, submitInsuranceApplication, submitInsuranceClaim } from "@/lib/app-api";
import { AppHeader } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatMoney } from "@/lib/currency";

const APPLIANCES = ["Refrigerator", "Stove / oven", "Air fryer", "Television", "Radio", "Soundbar", "Microwave", "Washing machine", "Dishwasher", "Kettle", "Toaster", "Vacuum cleaner"];

export const Route = createFileRoute("/_authenticated/insurance")({ component: InsurancePage });

async function uploadInsuranceFile(userId: string, category: string, file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10MB.`);
  const path = `${userId}/${category}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${file.name.split(".").pop() || "bin"}`;
  const result = await supabase.storage.from("insurance").upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
  if (result.error) throw result.error;
  return path;
}

function InsurancePage() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const { data, isLoading } = useQuery({ queryKey: ["insurance-dashboard"], queryFn: getInsuranceDashboard });
  const application = data?.application;
  if (isLoading || !me) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  const refresh = () => qc.invalidateQueries({ queryKey: ["insurance-dashboard"] });
  return <div className="min-h-screen pb-12"><AppHeader isAdmin={me.roles.includes("admin")} accountId={me.profile?.account_id} />
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 md:px-6 md:py-10">
      <Link to="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />Back to dashboard</Link>
      <div><h1 className="font-display text-3xl font-bold">Insure your home appliances</h1><p className="text-sm text-muted-foreground">Apply for cover and manage approved claims in one place.</p></div>
      {!application || application.status === "declined"
        ? <ApplicationForm userId={me.profile.id} previous={application} onDone={refresh} />
        : application.status === "pending"
          ? <Card className="rounded-2xl p-6"><div className="flex gap-3"><Clock3 className="h-6 w-6 shrink-0 text-amber-500" /><div><h2 className="font-semibold">Application under review</h2><p className="mt-1 text-sm text-muted-foreground">Thank you for your application. Wait while your application is reviewed. The outcome will be available within 5 to 7 business days.</p><p className="mt-3 text-xs text-muted-foreground">Items: {application.selected_items.join(", ")}</p></div></div></Card>
          : <ApprovedDashboard application={application} claims={data?.claims ?? []} userId={me.profile.id} onDone={refresh} />}
    </main></div>;
}

function ApplicationForm({ userId, previous, onDone }: { userId: string; previous: any; onDone: () => void }) {
  const [items, setItems] = useState<string[]>([]);
  const [bankFiles, setBankFiles] = useState<File[]>([]);
  const [payslip, setPayslip] = useState<File | null>(null);
  const [idCopy, setIdCopy] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!items.length) return toast.error("Select at least one appliance.");
    if (!bankFiles.length || !payslip || !idCopy) return toast.error("Upload your bank statements, latest payslip and ID copy.");
    setBusy(true);
    try {
      const bankStatementPaths: string[] = [];
      for (const file of bankFiles) bankStatementPaths.push(await uploadInsuranceFile(userId, "bank-statement", file));
      const payslipPath = await uploadInsuranceFile(userId, "payslip", payslip);
      const idCopyPath = await uploadInsuranceFile(userId, "id-copy", idCopy);
      await submitInsuranceApplication({ data: { items, bankStatementPaths, payslipPath, idCopyPath } });
      toast.success("Thank you for your application. The outcome will be available within 5 to 7 business days.", { duration: 10_000 });
      onDone();
    } catch (error: any) { toast.error(error.message); } finally { setBusy(false); }
  };
  return <Card className="rounded-2xl p-5 md:p-6">
    <h2 className="font-display text-xl font-semibold">Insurance application</h2>
    {previous?.status === "declined" && <p className="mt-2 rounded-lg bg-rose-500/10 p-3 text-sm text-rose-700">Your previous application was declined.{previous.admin_note ? ` ${previous.admin_note}` : ""} You may submit a new application.</p>}
    <div className="mt-5 space-y-5">
      <div><Label>Items to insure</Label><div className="mt-2 grid gap-2 sm:grid-cols-2 md:grid-cols-3">{APPLIANCES.map(item => <label key={item} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" checked={items.includes(item)} onChange={event => setItems(event.target.checked ? [...items, item] : items.filter(value => value !== item))} />{item}</label>)}</div></div>
      <div><Label htmlFor="bank-statements">Latest 3 months bank statements (up to 3 files)</Label><Input id="bank-statements" type="file" multiple accept="image/*,application/pdf" onChange={event => setBankFiles(Array.from(event.target.files ?? []).slice(0, 3))} /></div>
      <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="payslip">Latest payslip</Label><Input id="payslip" type="file" accept="image/*,application/pdf" onChange={event => setPayslip(event.target.files?.[0] ?? null)} /></div><div><Label htmlFor="id-copy">ID copy</Label><Input id="id-copy" type="file" accept="image/*,application/pdf" onChange={event => setIdCopy(event.target.files?.[0] ?? null)} /></div></div>
      <Button disabled={busy} className="w-full gradient-brand text-white" onClick={submit}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Submit application</Button>
    </div>
  </Card>;
}

function ApprovedDashboard({ application, claims, userId, onDone }: { application: any; claims: any[]; userId: string; onDone: () => void }) {
  const [showClaim, setShowClaim] = useState(false);
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [quotation, setQuotation] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submitClaim = async () => {
    const value = Number(amount);
    if (!item || !quotation || !Number.isFinite(value) || value <= 0) return toast.error("Select an item, enter its cost and upload a quotation.");
    if (value > Number(application.credit_available)) return toast.error("The claim exceeds your available insurance facility.");
    setBusy(true);
    try {
      const quotationPath = await uploadInsuranceFile(userId, "quotation", quotation);
      await submitInsuranceClaim({ data: { item, amount: value, quotationPath } });
      toast.success("Claim submitted for administrator review.");
      setShowClaim(false); onDone();
    } catch (error: any) { toast.error(error.message); } finally { setBusy(false); }
  };
  return <div className="space-y-5">
    <Card className="overflow-hidden rounded-2xl"><div className="gradient-brand p-6 text-white"><div className="text-sm text-white/80">Insurance credit facility</div><div className="mt-1 font-display text-4xl font-bold">{formatMoney(Number(application.credit_limit), "ZAR")}</div><div className="mt-2 text-sm">Available to claim: {formatMoney(Number(application.credit_available), "ZAR")}</div></div><div className="p-5"><div className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-emerald-600" />Cover approved for {application.selected_items.length} appliance{application.selected_items.length === 1 ? "" : "s"}.</div><Button className="mt-4 gradient-brand text-white" disabled={Number(application.credit_available) <= 0} onClick={() => setShowClaim(value => !value)}><ShieldCheck className="mr-2 h-4 w-4" />Claim insurance</Button></div></Card>
    {showClaim && <Card className="rounded-2xl p-5"><h2 className="font-semibold">Submit an insurance claim</h2><div className="mt-4 space-y-4"><div><Label>Item being claimed</Label><Select value={item} onValueChange={setItem}><SelectTrigger><SelectValue placeholder="Select insured item" /></SelectTrigger><SelectContent>{application.selected_items.map((value: string) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="claim-amount">Repair or replacement cost (ZAR)</Label><Input id="claim-amount" type="number" min="1" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} /></div><div><Label htmlFor="quotation">Repair or replacement quotation</Label><Input id="quotation" type="file" accept="image/*,application/pdf" onChange={event => setQuotation(event.target.files?.[0] ?? null)} /></div><Button disabled={busy} onClick={submitClaim} className="w-full gradient-brand text-white">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Submit claim</Button></div></Card>}
    <Card className="rounded-2xl p-5"><h2 className="font-semibold">Claim history</h2><div className="mt-3 divide-y">{!claims.length && <p className="py-4 text-sm text-muted-foreground">No insurance claims yet.</p>}{claims.map(claim => <div key={claim.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><div className="font-medium">{claim.item}</div><div className="text-xs text-muted-foreground">{new Date(claim.created_at).toLocaleDateString()} · {claim.status}{claim.admin_note ? ` · ${claim.admin_note}` : ""}</div></div><div className="font-semibold">{formatMoney(Number(claim.approved_amount ?? claim.requested_amount), "ZAR")}</div></div>)}</div></Card>
  </div>;
}
