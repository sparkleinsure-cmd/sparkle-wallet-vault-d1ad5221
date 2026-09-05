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
  notification_kind: "withdrawable_credit" | "deposit_approved";
  cycle_label: string | null;
  maturity_date: string | null;
};

type SmsNotification = Notification & { recipient_phone: string };

type AdminMaturityTranche = {
  tranche_id: string;
  user_id: string;
  account_id: string | null;
  user_name: string;
  currency: "ZAR" | "USD";
  current_balance: number | string;
  cycle_label: string;
  maturity_date: string;
};

type AdminMaturityAlert = {
  notification_id: string;
  alert_date: string;
  maturity_window_end: string;
  tranche_count: number;
  tranches: AdminMaturityTranche[];
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

const formatSmsAmount = (amount: number | string, currency: "ZAR" | "USD") => {
  const value = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
  return `${currency === "ZAR" ? "R" : "$"}${value}`;
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Johannesburg",
  }).format(new Date(value));

const formatMaturityDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-ZA", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Africa/Johannesburg",
      }).format(new Date(value))
    : "Not specified";

function normalizePhone(value: string): string | null {
  let digits = value.trim().replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `27${digits.slice(1)}`;
  else if (/^[6-8]\d{8}$/.test(digits)) digits = `27${digits}`;
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

function smsContent(notification: SmsNotification): string {
  const amount = formatSmsAmount(notification.amount, notification.currency);
  const cycle = notification.cycle_label?.trim();
  const maturity = formatMaturityDate(notification.maturity_date);
  const raw =
    notification.notification_kind === "deposit_approved"
      ? `Sparkle Insure: Deposit ${amount} verified. Cycle: ${cycle ?? "confirmed"}. Matures ${maturity}. Sign in for details.`
      : cycle
        ? `Sparkle Insure: ${amount} credited to withdrawable. ${cycle} matured ${maturity}. Sign in for details.`
        : `Sparkle Insure: ${amount} credited to withdrawable. ${notification.reason}. Sign in for details.`;
  const ascii = raw
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ascii.length <= 160 ? ascii : `${ascii.slice(0, 157)}...`;
}

function emailContent(notification: Notification) {
  const displayAmount = formatAmount(notification.amount, notification.currency);
  const firstName = notification.recipient_name?.trim() || "Member";
  const eventDate = formatDate(notification.event_created_at);

  if (notification.notification_kind === "deposit_approved") {
    const cycle = notification.cycle_label?.trim() || "Confirmed cycle";
    const maturity = formatMaturityDate(notification.maturity_date);
    return {
      subject: "Deposit verified and approved",
      text: [
        `Hi ${firstName},`,
        "",
        "Your deposit has been verified and approved.",
        `Verified amount: ${displayAmount}`,
        `Growth cycle: ${cycle}`,
        `Maturity date: ${maturity}`,
        `Approved: ${eventDate}`,
        "",
        "You can sign in to Sparkle Insure to view your active cycle.",
        "",
        "Sparkle Insure",
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:auto">
          <h2 style="color:#6d28d9">Deposit verified and approved</h2>
          <p>Hi ${escapeHtml(firstName)},</p>
          <p>Your deposit has been verified and approved.</p>
          <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#f8fafc">
            <p style="margin:0 0 8px"><strong>Verified amount:</strong> ${escapeHtml(displayAmount)}</p>
            <p style="margin:0 0 8px"><strong>Growth cycle:</strong> ${escapeHtml(cycle)}</p>
            <p style="margin:0 0 8px"><strong>Maturity date:</strong> ${escapeHtml(maturity)}</p>
            <p style="margin:0"><strong>Approved:</strong> ${escapeHtml(eventDate)}</p>
          </div>
          <p>You can sign in to Sparkle Insure to view your active cycle.</p>
          <p>Kind regards,<br><strong>Sparkle Insure</strong></p>
        </div>`,
    };
  }

  const cycleRows = notification.cycle_label
    ? `<p style="margin:0 0 8px"><strong>Cycle:</strong> ${escapeHtml(notification.cycle_label)}</p>
       <p style="margin:0"><strong>Maturity date:</strong> ${escapeHtml(formatMaturityDate(notification.maturity_date))}</p>`
    : "";
  const cycleText = notification.cycle_label
    ? [
        `Cycle: ${notification.cycle_label}`,
        `Maturity date: ${formatMaturityDate(notification.maturity_date)}`,
      ]
    : [];
  return {
    subject: "Funds credited to your withdrawable account",
    text: [
      `Hi ${firstName},`,
      "",
      "Funds have been credited to your withdrawable account.",
      `Amount: ${displayAmount}`,
      `Activity: ${notification.reason}`,
      ...cycleText,
      `Date: ${eventDate}`,
      "",
      "You can sign in to Sparkle Insure to view your updated balance and transaction history.",
      "",
      "Sparkle Insure",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:auto">
        <h2 style="color:#6d28d9">Funds credited to your withdrawable account</h2>
        <p>Hi ${escapeHtml(firstName)},</p>
        <p>Funds have been credited to your withdrawable account.</p>
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#f8fafc">
          <p style="margin:0 0 8px"><strong>Amount:</strong> ${escapeHtml(displayAmount)}</p>
          <p style="margin:0 0 8px"><strong>Activity:</strong> ${escapeHtml(notification.reason)}</p>
          ${cycleRows}
          <p style="margin:${notification.cycle_label ? "8px 0 0" : "0"}"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
        </div>
        <p>You can sign in to Sparkle Insure to view your updated balance and transaction history.</p>
        <p>Kind regards,<br><strong>Sparkle Insure</strong></p>
      </div>`,
  };
}

function maturityTiming(value: string) {
  const maturity = new Date(value);
  const today = new Date();
  const maturityDay = new Date(maturity);
  today.setHours(0, 0, 0, 0);
  maturityDay.setHours(0, 0, 0, 0);
  const days = Math.round((maturityDay.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function adminMaturityEmailContent(alert: AdminMaturityAlert) {
  const tranches = Array.isArray(alert.tranches) ? alert.tranches : [];
  const subject = `${tranches.length} growing cycle${tranches.length === 1 ? "" : "s"} due within 5 days`;
  const textRows = tranches.map((tranche, index) => [
    `${index + 1}. ${tranche.user_name} (${tranche.account_id ?? "No account ID"})`,
    `   ${tranche.cycle_label} - ${formatAmount(tranche.current_balance, tranche.currency)}`,
    `   ${maturityTiming(tranche.maturity_date)} - ${formatMaturityDate(tranche.maturity_date)}`,
  ].join("\n"));
  const htmlRows = tranches.map((tranche) => `
    <div style="border:1px solid #fde68a;border-radius:12px;padding:14px;margin:0 0 10px;background:#fffbeb">
      <p style="margin:0 0 6px"><strong>${escapeHtml(tranche.user_name)}</strong> (${escapeHtml(tranche.account_id ?? "No account ID")})</p>
      <p style="margin:0 0 6px"><strong>Cycle:</strong> ${escapeHtml(tranche.cycle_label)}</p>
      <p style="margin:0 0 6px"><strong>Current value:</strong> ${escapeHtml(formatAmount(tranche.current_balance, tranche.currency))}</p>
      <p style="margin:0"><strong>Maturity:</strong> ${escapeHtml(formatMaturityDate(tranche.maturity_date))} · ${escapeHtml(maturityTiming(tranche.maturity_date))}</p>
    </div>`).join("");

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
        <p style="color:#64748b;font-size:12px">This digest is sent at most once per Johannesburg calendar day while maturities require attention.</p>
      </div>`,
  };
}

async function processAdminMaturityAlert(
  admin: ReturnType<typeof createClient>,
  resendKey: string,
  recipientEmail: string,
) {
  const claimed = await admin.rpc("claim_admin_maturity_alert_email");
  if (claimed.error) throw new Error(claimed.error.message);
  const alert = (claimed.data?.[0] ?? null) as AdminMaturityAlert | null;
  if (!alert) return { processed: 0, sent: 0, retrying: 0 };

  const content = adminMaturityEmailContent(alert);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `admin-maturity-alert/${alert.notification_id}`,
      },
      body: JSON.stringify({
        from: "Sparkle Insure <noreply@sparkleinsure.app>",
        to: [recipientEmail],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const completed = await admin.rpc("complete_admin_maturity_alert_email", {
      p_notification_id: alert.notification_id,
      p_success: response.ok,
      p_provider_message_id: response.ok && typeof payload.id === "string" ? payload.id : null,
      p_error: response.ok
        ? null
        : `Resend ${response.status}: ${JSON.stringify(payload)}`.slice(0, 500),
    });
    if (completed.error) console.error("Could not complete admin maturity alert", completed.error.message);
    return { processed: 1, sent: response.ok ? 1 : 0, retrying: response.ok ? 0 : 1 };
  } catch (error) {
    const completed = await admin.rpc("complete_admin_maturity_alert_email", {
      p_notification_id: alert.notification_id,
      p_success: false,
      p_provider_message_id: null,
      p_error: error instanceof Error ? error.message.slice(0, 500) : "Email request failed",
    });
    if (completed.error) console.error("Could not record admin maturity alert failure", completed.error.message);
    return { processed: 1, sent: 0, retrying: 1 };
  }
}

async function processEmails(admin: ReturnType<typeof createClient>, resendKey: string) {
  const claimed = await admin.rpc("claim_fund_notification_emails", { p_limit: 20 });
  if (claimed.error) throw new Error(claimed.error.message);
  let sent = 0;
  let retrying = 0;
  for (const notification of (claimed.data ?? []) as Notification[]) {
    const content = emailContent(notification);
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `fund-notification/${notification.notification_id}`,
        },
        body: JSON.stringify({
          from: "Sparkle Insure <noreply@sparkleinsure.app>",
          to: [notification.recipient_email],
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const success = response.ok;
      const completed = await admin.rpc("complete_withdrawable_credit_email", {
        p_notification_id: notification.notification_id,
        p_success: success,
        p_provider_message_id: success && typeof payload.id === "string" ? payload.id : null,
        p_error: success
          ? null
          : `Resend ${response.status}: ${JSON.stringify(payload)}`.slice(0, 500),
      });
      if (completed.error)
        console.error("Could not complete email notification", completed.error.message);
      if (success) sent += 1;
      else retrying += 1;
    } catch (error) {
      retrying += 1;
      const completed = await admin.rpc("complete_withdrawable_credit_email", {
        p_notification_id: notification.notification_id,
        p_success: false,
        p_provider_message_id: null,
        p_error: error instanceof Error ? error.message.slice(0, 500) : "Email request failed",
      });
      if (completed.error) console.error("Could not record email failure", completed.error.message);
    }
  }
  return { processed: claimed.data?.length ?? 0, sent, retrying };
}

async function processSms(
  admin: ReturnType<typeof createClient>,
  username: string,
  password: string,
) {
  const claimed = await admin.rpc("claim_fund_notification_sms", { p_limit: 20 });
  if (claimed.error) throw new Error(claimed.error.message);
  const authorization = `Basic ${btoa(`${username}:${password}`)}`;
  let sent = 0;
  let retrying = 0;
  let failed = 0;

  for (const notification of (claimed.data ?? []) as SmsNotification[]) {
    const destination = normalizePhone(notification.recipient_phone);
    if (!destination) {
      failed += 1;
      const completed = await admin.rpc("complete_fund_notification_sms", {
        p_notification_id: notification.notification_id,
        p_success: false,
        p_provider_message_id: null,
        p_error: "Invalid recipient phone number",
        p_permanent_failure: true,
      });
      if (completed.error)
        console.error("Could not record invalid SMS recipient", completed.error.message);
      continue;
    }

    try {
      const response = await fetch("https://rest.smsportal.com/v3/BulkMessages", {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: [{ content: smsContent(notification), destination }] }),
      });
      const payload = await response.json().catch(() => ({}));
      const success = response.ok;
      const providerId = payload.eventId ?? payload.EventId ?? payload.id ?? payload.Id;
      const completed = await admin.rpc("complete_fund_notification_sms", {
        p_notification_id: notification.notification_id,
        p_success: success,
        p_provider_message_id: success && providerId != null ? String(providerId) : null,
        p_error: success
          ? null
          : `SMSPortal ${response.status}: ${JSON.stringify(payload)}`.slice(0, 500),
        p_permanent_failure: false,
      });
      if (completed.error)
        console.error("Could not complete SMS notification", completed.error.message);
      if (success) sent += 1;
      else retrying += 1;
    } catch (error) {
      retrying += 1;
      const completed = await admin.rpc("complete_fund_notification_sms", {
        p_notification_id: notification.notification_id,
        p_success: false,
        p_provider_message_id: null,
        p_error: error instanceof Error ? error.message.slice(0, 500) : "SMSPortal request failed",
        p_permanent_failure: false,
      });
      if (completed.error) console.error("Could not record SMS failure", completed.error.message);
    }
  }
  return { processed: claimed.data?.length ?? 0, sent, retrying, failed };
}

serve(async (request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const adminNotificationEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL")?.trim() || "sparkleinsure@gmail.com";
  const smsPortalUsername = Deno.env.get("SMSPORTAL_API_KEY_USERNAME");
  const smsPortalPassword = Deno.env.get("SMSPORTAL_API_KEY_PASSWORD");
  const emailConfigured = Boolean(resendKey);
  const smsConfigured = Boolean(smsPortalUsername && smsPortalPassword);

  if (request.method === "GET") {
    return json({
      ok: true,
      configured: Boolean(supabaseUrl && serviceRoleKey && emailConfigured && smsConfigured),
      emailConfigured,
      smsConfigured,
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!supabaseUrl || !serviceRoleKey || (!emailConfigured && !smsConfigured)) {
    return json({ error: "Financial notification worker is not configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const email = resendKey
      ? await processEmails(admin, resendKey)
      : { processed: 0, sent: 0, retrying: 0 };
    const sms =
      smsPortalUsername && smsPortalPassword
        ? await processSms(admin, smsPortalUsername, smsPortalPassword)
        : { processed: 0, sent: 0, retrying: 0, failed: 0 };
    const adminMaturity = resendKey
      ? await processAdminMaturityAlert(admin, resendKey, adminNotificationEmail)
      : { processed: 0, sent: 0, retrying: 0 };
    return json({ ok: true, email, sms, adminMaturity });
  } catch (error) {
    console.error("Financial notification worker failed", error);
    return json(
      { error: error instanceof Error ? error.message : "Notification worker failed" },
      500,
    );
  }
});
