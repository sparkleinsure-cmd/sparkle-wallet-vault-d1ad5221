import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type MaturityTranche = {
  tranche_id: string;
  account_id: string | null;
  user_name: string;
  currency: "ZAR" | "USD";
  current_balance: number | string;
  cycle_label: string;
  maturity_date: string;
};

type MaturityAlert = {
  notification_id: string;
  alert_date: string;
  maturity_window_end: string;
  tranche_count: number;
  tranches: MaturityTranche[];
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character] ?? character,
  );

const formatAmount = (amount: number | string, currency: "ZAR" | "USD") =>
  new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));

const formatMaturityDate = (value: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  }).format(new Date(value));

function johannesburgDayNumber(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Africa/Johannesburg",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

function maturityTiming(value: string) {
  const days = johannesburgDayNumber(new Date(value)) - johannesburgDayNumber(new Date());
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function emailContent(alert: MaturityAlert) {
  const tranches = Array.isArray(alert.tranches) ? alert.tranches : [];
  const subject = `${tranches.length} growing cycle${tranches.length === 1 ? "" : "s"} due within 5 days`;
  const textRows = tranches.map((tranche, index) =>
    [
      `${index + 1}. ${tranche.user_name} (${tranche.account_id ?? "No account ID"})`,
      `   ${tranche.cycle_label} - ${formatAmount(tranche.current_balance, tranche.currency)}`,
      `   ${maturityTiming(tranche.maturity_date)} - ${formatMaturityDate(tranche.maturity_date)}`,
    ].join("\n"),
  );
  const htmlRows = tranches
    .map(
      (tranche) => `
        <div style="border:1px solid #fde68a;border-radius:12px;padding:14px;margin:0 0 10px;background:#fffbeb">
          <p style="margin:0 0 6px"><strong>${escapeHtml(tranche.user_name)}</strong> (${escapeHtml(tranche.account_id ?? "No account ID")})</p>
          <p style="margin:0 0 6px"><strong>Cycle:</strong> ${escapeHtml(tranche.cycle_label)}</p>
          <p style="margin:0 0 6px"><strong>Current value:</strong> ${escapeHtml(formatAmount(tranche.current_balance, tranche.currency))}</p>
          <p style="margin:0"><strong>Maturity:</strong> ${escapeHtml(formatMaturityDate(tranche.maturity_date))} · ${escapeHtml(maturityTiming(tranche.maturity_date))}</p>
        </div>`,
    )
    .join("");

  return {
    subject,
    text: [
      "Sparkle Insure maturity alert",
      "",
      `${tranches.length} approved active growing cycle${tranches.length === 1 ? " is" : "s are"} overdue or due within the next five days.`,
      "",
      ...textRows,
      "",
      "Open the Admin Console to review and prepare for these maturities:",
      "https://sparkleinsure.app/admin",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#172033;max-width:620px;margin:auto">
        <h2 style="color:#b45309">Maturity alert</h2>
        <p><strong>${tranches.length}</strong> approved active growing cycle${tranches.length === 1 ? " is" : "s are"} overdue or due within the next five days.</p>
        ${htmlRows}
        <p><a href="https://sparkleinsure.app/admin" style="display:inline-block;background:#07869d;color:#fff;text-decoration:none;padding:11px 16px;border-radius:10px;font-weight:bold">Open Admin Console</a></p>
        <p style="color:#64748b;font-size:12px">Scheduled daily at 00:00 South African Standard Time.</p>
      </div>`,
  };
}

serve(async (request) => {
  if (request.method === "GET") {
    return json({
      ok: true,
      emailOnly: true,
      schedule: "00:00 SAST",
      configured: Boolean(
        Deno.env.get("SUPABASE_URL") &&
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") &&
          Deno.env.get("RESEND_API_KEY"),
      ),
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const recipientEmail =
    Deno.env.get("ADMIN_NOTIFICATION_EMAIL")?.trim() || "sparkleinsure@gmail.com";
  const from =
    Deno.env.get("RESEND_FROM_EMAIL") ?? "Sparkle Insure <noreply@sparkleinsure.app>";

  if (!supabaseUrl || !serviceRoleKey || !resendKey) {
    return json({ error: "Admin maturity email is not configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const claimed = await admin.rpc("claim_admin_maturity_alert_email");
    if (claimed.error) throw new Error(claimed.error.message);
    const alert = (claimed.data?.[0] ?? null) as MaturityAlert | null;
    if (!alert) return json({ ok: true, emailOnly: true, processed: 0, sent: 0 });

    const content = emailContent(alert);
    let success = false;
    let providerMessageId: string | null = null;
    let deliveryError: string | null = null;

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `admin-maturity-alert/${alert.notification_id}`,
        },
        body: JSON.stringify({
          from,
          to: [recipientEmail],
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      success = response.ok;
      providerMessageId = success && typeof payload.id === "string" ? payload.id : null;
      deliveryError = success
        ? null
        : `Resend ${response.status}: ${JSON.stringify(payload)}`.slice(0, 500);
    } catch (error) {
      deliveryError = error instanceof Error ? error.message.slice(0, 500) : "Email request failed";
    }

    const completed = await admin.rpc("complete_admin_maturity_alert_email", {
      p_notification_id: alert.notification_id,
      p_success: success,
      p_provider_message_id: providerMessageId,
      p_error: deliveryError,
    });
    if (completed.error) throw new Error(completed.error.message);

    return json({
      ok: success,
      emailOnly: true,
      processed: 1,
      sent: success ? 1 : 0,
      retrying: success ? 0 : 1,
      error: deliveryError,
    }, success ? 200 : 502);
  } catch (error) {
    console.error("Admin maturity email worker failed", error);
    return json(
      { error: error instanceof Error ? error.message : "Admin maturity email worker failed" },
      500,
    );
  }
});
