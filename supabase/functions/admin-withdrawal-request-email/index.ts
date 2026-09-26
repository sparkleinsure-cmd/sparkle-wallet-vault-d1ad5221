import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { withdrawalEmailContent, type WithdrawalAlert } from "./email.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

serve(async request => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (request.method === "GET") {
    return json({ ok: true, emailOnly: true, configured: Boolean(url && serviceKey && resendKey) });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!url || !serviceKey || !resendKey) return json({ error: "Withdrawal emails are not configured" }, 503);

  // This endpoint accepts no recipient or message data. Only committed queue
  // entries, atomically claimed with service-role privileges, can generate mail.
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const claimed = await admin.rpc("claim_admin_withdrawal_request_emails", { p_limit: 5 });
    if (claimed.error) throw new Error("Could not claim withdrawal notifications");
    let sent = 0;
    let retrying = 0;
    for (const alert of (claimed.data ?? []) as WithdrawalAlert[]) {
      let success = false;
      let providerMessageId: string | null = null;
      let error: string | null = null;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `admin-withdrawal-request/${alert.notification_id}`,
          },
          body: JSON.stringify({
            from: Deno.env.get("RESEND_FROM_EMAIL") ?? "Sparkle Insure <noreply@sparkleinsure.app>",
            to: ["sparkleinsure@gmail.com"],
            ...withdrawalEmailContent(alert),
          }),
        });
        const payload = await response.json().catch(() => ({}));
        success = response.ok && typeof payload.id === "string";
        providerMessageId = success ? payload.id : null;
        if (!success) error = `Email provider returned HTTP ${response.status} without accepting the message`;
      } catch {
        error = "Email provider request failed or timed out";
      }
      const completed = await admin.rpc("complete_admin_withdrawal_request_email", {
        p_notification_id: alert.notification_id,
        p_success: success,
        p_provider_message_id: providerMessageId,
        p_error: error,
      });
      if (completed.error) throw new Error("Could not record withdrawal notification result");
      if (success) sent++;
      else retrying++;
    }
    return json({ ok: retrying === 0, processed: claimed.data?.length ?? 0, sent, retrying });
  } catch {
    return json({ error: "Withdrawal notification processing failed" }, 500);
  }
});
