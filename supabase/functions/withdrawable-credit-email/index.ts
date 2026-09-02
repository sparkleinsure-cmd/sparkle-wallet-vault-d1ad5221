import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type Notification = {
  notification_id: string;
  recipient_email: string;
  recipient_name: string | null;
  currency: "ZAR" | "USD";
  amount: number | string;
  reason: string;
  event_key: string;
  event_created_at: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);

const formatAmount = (amount: number | string, currency: "ZAR" | "USD") =>
  new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));

serve(async (request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (request.method === "GET") {
    return json({
      ok: true,
      configured: Boolean(supabaseUrl && serviceRoleKey && resendKey),
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!supabaseUrl || !serviceRoleKey || !resendKey) {
    return json({ error: "Email worker is not configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const claimed = await admin.rpc("claim_withdrawable_credit_emails", { p_limit: 20 });
  if (claimed.error) return json({ error: claimed.error.message }, 500);

  let sent = 0;
  let retrying = 0;
  for (const notification of (claimed.data ?? []) as Notification[]) {
    const displayAmount = formatAmount(notification.amount, notification.currency);
    const firstName = notification.recipient_name?.trim() || "Member";
    const eventDate = new Date(notification.event_created_at).toLocaleString("en-ZA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Johannesburg",
    });
    const subject = "Funds credited to your withdrawable account";
    const text = [
      `Hi ${firstName},`,
      "",
      "Funds have been credited to your withdrawable account.",
      `Amount: ${displayAmount}`,
      `Activity: ${notification.reason}`,
      `Date: ${eventDate}`,
      "",
      "You can sign in to Sparkle Insure to view your updated balance and transaction history.",
      "",
      "Sparkle Insure",
    ].join("\n");
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:auto">
        <h2 style="color:#6d28d9">Funds credited to your withdrawable account</h2>
        <p>Hi ${escapeHtml(firstName)},</p>
        <p>Funds have been credited to your withdrawable account.</p>
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#f8fafc">
          <p style="margin:0 0 8px"><strong>Amount:</strong> ${escapeHtml(displayAmount)}</p>
          <p style="margin:0 0 8px"><strong>Activity:</strong> ${escapeHtml(notification.reason)}</p>
          <p style="margin:0"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
        </div>
        <p>You can sign in to Sparkle Insure to view your updated balance and transaction history.</p>
        <p>Kind regards,<br><strong>Sparkle Insure</strong></p>
      </div>`;

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `withdrawable-credit/${notification.notification_id}`,
        },
        body: JSON.stringify({
          from: "Sparkle Insure <noreply@sparkleinsure.app>",
          to: [notification.recipient_email],
          subject,
          text,
          html,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const success = response.ok;
      await admin.rpc("complete_withdrawable_credit_email", {
        p_notification_id: notification.notification_id,
        p_success: success,
        p_provider_message_id: success && typeof payload.id === "string" ? payload.id : null,
        p_error: success ? null : `Resend ${response.status}: ${JSON.stringify(payload)}`.slice(0, 500),
      });
      if (success) sent += 1;
      else retrying += 1;
    } catch (error) {
      retrying += 1;
      await admin.rpc("complete_withdrawable_credit_email", {
        p_notification_id: notification.notification_id,
        p_success: false,
        p_provider_message_id: null,
        p_error: error instanceof Error ? error.message.slice(0, 500) : "Email request failed",
      });
    }
  }

  return json({ ok: true, processed: claimed.data?.length ?? 0, sent, retrying });
});
