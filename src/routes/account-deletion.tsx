import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/account-deletion")({
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-12">
      <div>
        <p className="text-sm font-medium text-primary">Sparkle Insure</p>
        <h1 className="mt-2 font-display text-3xl font-bold">Delete your account</h1>
        <p className="mt-3 text-muted-foreground">
          You can permanently delete your Sparkle account and its associated profile, wallet, transaction, and verification records.
          Hashed signup and device signals are retained only to prevent repeated welcome-bonus claims.
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        <li>Open Sparkle and sign in to the account you want to delete.</li>
        <li>Go to Settings, choose Delete account, and type DELETE to confirm.</li>
        <li>Your account and associated data are deleted immediately. This cannot be undone.</li>
      </ol>
      <p className="text-sm text-muted-foreground">
        If you cannot sign in, contact <a className="text-primary underline" href="mailto:support@sparkleinsure.com?subject=Account%20deletion%20help">support@sparkleinsure.com</a> from the email address registered to your account.
      </p>
      <Button asChild className="w-fit gradient-brand text-white"><Link to="/auth" search={{ mode: "signin" }}>Open Sparkle</Link></Button>
    </main>
  );
}
