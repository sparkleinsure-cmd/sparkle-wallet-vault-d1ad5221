import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Mail,
  ShieldCheck,
  Trash2,
} from "lucide-react";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const handleDeleteAccount = () => {
    const confirmed = window.confirm(
      "This will open your mail app to request account deletion. Continue?"
    );
    if (!confirmed) return;

    window.location.href =
      "mailto:support@yourdomain.com?subject=Delete%20my%20account";
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
      </div>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage account actions and app compliance links.
        </p>
      </div>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-red-500" />
          <h2 className="font-medium">Delete account</h2>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Request account deletion. This opens your mail app so you can send a
          deletion request.
        </p>
        <button
          onClick={handleDeleteAccount}
          className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          Request deletion
        </button>
      </section>

      <section className="rounded-lg border bg-background p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-blue-500" />
          <h2 className="font-medium">Apple / Google compliance</h2>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border p-3">
            <span>Privacy policy</span>
            <a
              href="https://yourdomain.com/privacy-policy"
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
              href="https://yourdomain.com/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600"
            >
              Open <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <span>Support email</span>
            <a
              href="mailto:support@yourdomain.com"
              className="inline-flex items-center gap-1 text-blue-600"
            >
              Contact <Mail className="h-3.5 w-3.5" />
            </a>
          </div>
  );
}