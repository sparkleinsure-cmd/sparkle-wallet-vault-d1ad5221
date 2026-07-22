// ...existing code...
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Camera, ExternalLink, Landmark, Mail, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deleteMyAccount, getMe, requestPayoutDetailsChange, setPayoutDetails, submitKycReview, updateProfileContact } from "@/lib/app-api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState<string | null>(null);
  const [isSubmittingKyc, setIsSubmittingKyc] = useState(false);
  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [isSavingPayoutDetails, setIsSavingPayoutDetails] = useState(false);
  const [phone, setPhone] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [province, setProvince] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [isSavingContact, setIsSavingContact] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const hasBankDetails = Boolean(me?.profile?.bank_name && me?.profile?.bank_account_number);
  const bankChangeAvailableAt = me?.profile?.bank_details_change_requested_at ? new Date(new Date(me.profile.bank_details_change_requested_at).getTime() + 7 * 864e5) : null;
  const canEditBank = !hasBankDetails || Boolean(bankChangeAvailableAt && bankChangeAvailableAt.getTime() <= Date.now());
  useEffect(() => {
    if (!me?.profile) return;
    setPhone(me.profile.phone ?? ""); setStreetAddress(me.profile.street_address ?? "");
    setProvince(me.profile.province ?? ""); setPostalCode(me.profile.postal_code ?? "");
  }, [me?.profile?.id, me?.profile?.phone, me?.profile?.street_address, me?.profile?.province, me?.profile?.postal_code]);

  const saveContact = async () => {
    setIsSavingContact(true);
    try {
      await updateProfileContact({ data: { phone: phone.trim(), streetAddress: streetAddress.trim(), province: province.trim(), postalCode: postalCode.trim() } });
      toast.success("Contact details updated."); await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (error:any) { toast.error(error.message ?? "Unable to update contact details."); }
    finally { setIsSavingContact(false); }
  };

  const submitKyc = async () => {
    if (!hasBankDetails) return toast.error("Save your banking details before submitting your selfie.");
    if (!selfie) return toast.error("Take or choose a clear selfie first.");
    if (selfie.size > 8 * 1024 * 1024) return toast.error("Your selfie must be under 8MB.");
    setIsSubmittingKyc(true);
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data.user?.id;
      if (!userId) throw new Error("Please sign in again.");
      const stamp = Date.now();
      const selfiePath = `${userId}/selfie-${stamp}.${selfie.name.split(".").pop() || "jpg"}`;
      const selfieUpload = await supabase.storage.from("kyc").upload(selfiePath, selfie, { upsert: false, contentType: selfie.type || "image/jpeg" });
      if (selfieUpload.error) throw selfieUpload.error;
      await submitKycReview({ data: { selfiePath } });
      toast.success("Selfie submitted. Your R10 bonus will be credited after admin approval.");
      setSelfie(null); setSelfiePreview(null);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (error: any) {
      toast.error(error.message ?? "Unable to submit KYC documents.");
    } finally {
      setIsSubmittingKyc(false);
    }
  };

  const chooseSelfie = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Please choose an image.");
    setSelfie(file);
    if (selfiePreview) URL.revokeObjectURL(selfiePreview);
    setSelfiePreview(URL.createObjectURL(file));
  };

  const savePayoutDetails = async () => {
    if (!bankName.trim() || !bankAccountNumber.trim()) return toast.error("Enter your bank name and account number.");
    setIsSavingPayoutDetails(true);
    try {
      await setPayoutDetails({ data: { bankName: bankName.trim(), accountNumber: bankAccountNumber.trim() } });
      toast.success("Registered payout details saved.");
      setBankName(""); setBankAccountNumber("");
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (error: any) {
      toast.error(error.message ?? "Unable to save payout details.");
    } finally {
      setIsSavingPayoutDetails(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "DELETE") {
      alert("Please type DELETE to confirm account deletion.");
      return;
    }

    const confirmed = window.confirm(
      "Are you absolutely sure? This will request deletion of your account."
    );
    if (!confirmed) return;

    setIsDeleting(true);

    try {
      await deleteMyAccount();

      // Sign out locally and clear client cache
      await qc.cancelQueries();
      qc.clear();
      await supabase.auth.signOut();

      // Redirect to signup/auth screen
      navigate({ to: "/auth/signup", replace: true });
    } catch (error) {
      console.error("Delete account error:", error);
      alert("We could not delete your account. Please contact support@sparkleinsure.com if the problem continues.");
      setIsDeleting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Link to="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
      </div>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage account actions and legal links.</p>
      </div>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2"><UserRound className="h-4 w-4 text-primary" /><h2 className="font-medium">Your details</h2></div>
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg bg-muted/40 p-3"><dt className="text-xs text-muted-foreground">Name</dt><dd className="mt-1 font-medium">{me?.profile?.first_name ?? "—"}</dd></div>
          <div className="rounded-lg bg-muted/40 p-3"><dt className="text-xs text-muted-foreground">Surname</dt><dd className="mt-1 font-medium">{me?.profile?.surname ?? "—"}</dd></div>
          <div className="rounded-lg bg-muted/40 p-3"><dt className="text-xs text-muted-foreground">Account number (User ID)</dt><dd className="mt-1 font-mono font-medium">{me?.profile?.account_id ?? "—"}</dd></div>
        </dl>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor="profile-phone">Phone number</Label><Input id="profile-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div><Label htmlFor="street-address">Street address</Label><Input id="street-address" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} placeholder="Street name and number" /></div>
          <div><Label htmlFor="province">Province</Label><Input id="province" value={province} onChange={(e) => setProvince(e.target.value)} /></div>
          <div><Label htmlFor="postal-code">Postal code</Label><Input id="postal-code" inputMode="numeric" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} /></div>
        </div>
        <Button type="button" onClick={saveContact} disabled={isSavingContact} className="mt-4 gradient-brand text-white">{isSavingContact ? "Saving…" : "Save contact details"}</Button>
      </section>

      <section id="verification" className="scroll-mt-4 rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Landmark className="h-4 w-4 text-primary" />
          <h2 className="font-medium">Registered payout details</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Withdrawals are paid only to this saved account. Current bank: {me?.profile?.bank_name ?? "not added"}.
        </p>
        {hasBankDetails && !canEditBank ? <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">{me.profile.bank_name} · account ending {String(me.profile.bank_account_number).slice(-4)}</div>
          {bankChangeAvailableAt ? <p className="text-sm text-muted-foreground">Editing unlocks on {bankChangeAvailableAt.toLocaleDateString("en-ZA", { dateStyle: "medium" })}.</p> : <Button type="button" variant="outline" onClick={async () => { try { const result = await requestPayoutDetailsChange(); toast.success(`Editing unlocks on ${new Date(result.availableAt).toLocaleDateString("en-ZA", { dateStyle: "medium" })}.`); await qc.invalidateQueries({ queryKey: ["me"] }); } catch (e:any) { toast.error(e.message); } }}>Request to update banking details</Button>}
        </div> : <div className="space-y-3">
          <div>
            <Label htmlFor="registered-bank">Bank name</Label>
            <Input id="registered-bank" value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="e.g. FNB" />
          </div>
          <div>
            <Label htmlFor="registered-account">Bank account number</Label>
            <Input id="registered-account" inputMode="numeric" value={bankAccountNumber} onChange={(event) => setBankAccountNumber(event.target.value)} placeholder="Your registered bank account number" />
          </div>
          <Button type="button" onClick={savePayoutDetails} disabled={isSavingPayoutDetails} className="gradient-brand text-white">
            {isSavingPayoutDetails ? "Saving…" : "Save payout details"}
          </Button>
        </div>}
      </section>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h2 className="font-medium">Welcome bonus selfie</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Take a clear, front-facing selfie. An administrator must approve it before your R10 welcome bonus is credited to your growing account.
          {me?.profile?.kyc_status ? ` Current status: ${me.profile.kyc_status}.` : ""}
        </p>
        <div className="space-y-3">
          {selfiePreview && <img src={selfiePreview} alt="Selfie preview" className="mx-auto aspect-square w-full max-w-xs rounded-xl object-cover" />}
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="outline" asChild><Label htmlFor="take-selfie" className="cursor-pointer"><Camera className="mr-2 h-4 w-4" />Take selfie</Label></Button>
            <Input id="take-selfie" className="sr-only" type="file" accept="image/*" capture="user" onChange={(event) => chooseSelfie(event.target.files?.[0] ?? null)} />
            <Button type="button" variant="outline" asChild><Label htmlFor="choose-selfie" className="cursor-pointer">Choose existing photo</Label></Button>
            <Input id="choose-selfie" className="sr-only" type="file" accept="image/*" onChange={(event) => chooseSelfie(event.target.files?.[0] ?? null)} />
          </div>
          <p className="text-xs text-muted-foreground">“Take selfie” opens the front camera on supported phones. If camera access is unavailable, choose a photo instead.</p>
          <Button type="button" onClick={submitKyc} disabled={isSubmittingKyc} className="gradient-brand text-white">
            {isSubmittingKyc ? "Submitting…" : me?.profile?.kyc_status === "pending" ? "Resubmit selfie for review" : "Submit selfie for review"}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-red-500" />
          <h2 className="font-medium">Delete account</h2>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Request permanent deletion of your account and all associated data. This action cannot be undone.
        </p>

        <div className="space-y-3">
          <input
            type="text"
            placeholder="Type DELETE to confirm"
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={handleDeleteAccount}
            disabled={isDeleting || deleteConfirm !== "DELETE"}
            className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isDeleting ? "Processing..." : "Delete account"}
          </button>
        </div>
      </section>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-blue-500" />
          <h2 className="font-medium">Legal</h2>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border p-3">
            <span>Privacy policy</span>
            <a
              href="https://sparkleinsure.com/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600"
            >
              Open <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <span>Terms of service</span>
            <a
              href="https://sparkleinsure.com/terms-of-service"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600"
            >
              Open <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <span>Support email</span>
            <a href="mailto:support@sparkleinsure.com" className="inline-flex items-center gap-1 text-blue-600">
              Contact <Mail className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
// ...existing code...
