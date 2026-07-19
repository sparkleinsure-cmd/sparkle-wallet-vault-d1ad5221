// ...existing code...
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Mail, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deleteMyAccount, getMe, submitKycReview } from "@/lib/app-api";
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
  const [bankProof, setBankProof] = useState<File | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [isSubmittingKyc, setIsSubmittingKyc] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });

  const submitKyc = async () => {
    if (!bankProof || !selfie) return toast.error("Upload both your proof of banking details and a selfie.");
    if (bankProof.size > 5 * 1024 * 1024 || selfie.size > 8 * 1024 * 1024) return toast.error("Banking proof must be under 5MB and selfie under 8MB.");
    setIsSubmittingKyc(true);
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data.user?.id;
      if (!userId) throw new Error("Please sign in again.");
      const stamp = Date.now();
      const bankPath = `${userId}/banking-${stamp}.${bankProof.name.split(".").pop() || "bin"}`;
      const selfiePath = `${userId}/selfie-${stamp}.${selfie.name.split(".").pop() || "jpg"}`;
      const [bankUpload, selfieUpload] = await Promise.all([
        supabase.storage.from("kyc").upload(bankPath, bankProof, { upsert: false, contentType: bankProof.type || "application/octet-stream" }),
        supabase.storage.from("kyc").upload(selfiePath, selfie, { upsert: false, contentType: selfie.type || "image/jpeg" }),
      ]);
      if (bankUpload.error) throw bankUpload.error;
      if (selfieUpload.error) throw selfieUpload.error;
      await submitKycReview({ data: { bankProofPath: bankPath, selfiePath } });
      toast.success("KYC documents submitted for administrator review.");
      setBankProof(null); setSelfie(null);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (error: any) {
      toast.error(error.message ?? "Unable to submit KYC documents.");
    } finally {
      setIsSubmittingKyc(false);
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
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h2 className="font-medium">Withdrawal verification</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          You can use Sparkle and deposit immediately. Submit these documents before requesting a withdrawal; an administrator must approve them first.
          {me?.profile?.kyc_status ? ` Current status: ${me.profile.kyc_status}.` : ""}
        </p>
        <div className="space-y-3">
          <div>
            <Label htmlFor="bank-proof">Proof of banking details</Label>
            <Input id="bank-proof" type="file" accept="image/*,application/pdf" onChange={(event) => setBankProof(event.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label htmlFor="kyc-selfie">Photo of yourself</Label>
            <Input id="kyc-selfie" type="file" accept="image/*" onChange={(event) => setSelfie(event.target.files?.[0] ?? null)} />
          </div>
          <Button type="button" onClick={submitKyc} disabled={isSubmittingKyc} className="gradient-brand text-white">
            {isSubmittingKyc ? "Submitting…" : "Submit documents for review"}
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
