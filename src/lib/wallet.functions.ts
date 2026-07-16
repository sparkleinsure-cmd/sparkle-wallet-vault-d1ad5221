import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CURRENCIES = ["ZAR", "USD"] as const;

const ADMIN_EMAIL = "sparkleinsure@gmail.com";

async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const resendKey = process.env.RESEND_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!resendKey || !lovableKey) {
    console.log(`[email:no-provider] to=${to} subject="${subject}"\n${text}`);
    return { ok: false, error: "email_provider_not_configured" };
  }
  try {
    const res = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": resendKey,
      },
      body: JSON.stringify({
        from: "Sparkle Insure <onboarding@resend.dev>",
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[email:send-failed] ${res.status} ${body}`);
      return { ok: false, error: `provider_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.error("[email:send-error]", err);
    return { ok: false, error: err?.message ?? "send_error" };
  }
}

export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [profileRes, walletsRes, txRes, rolesRes, tranchesRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabase.from("wallets").select("*").eq("user_id", userId).order("currency"),
      supabase.from("transactions").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("deposit_tranches").select("*").eq("user_id", userId).gt("remaining", 0).order("created_at"),
    ]);
    if (profileRes.error) throw new Error(profileRes.error.message);
    return {
      profile: profileRes.data,
      wallets: walletsRes.data ?? [],
      transactions: txRes.data ?? [],
      roles: (rolesRes.data ?? []).map((r) => r.role as string),
      tranches: tranchesRes.data ?? [],
    };
  });

export const setPrimaryCurrency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { currency: string }) =>
    z.object({ currency: z.enum(CURRENCIES) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("profiles")
      .update({ primary_currency: data.currency })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const creditDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { amount: number; currency: string; reference: string; proofUrl: string }) =>
    z
      .object({
        amount: z.number().positive().max(10_000_000),
        currency: z.enum(CURRENCIES),
        reference: z.string().min(3).max(200),
        proofUrl: z.string().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Idempotency: don't credit twice for same reference
    const existing = await supabase
      .from("transactions")
      .select("id")
      .eq("reference", data.reference)
      .eq("user_id", userId)
      .maybeSingle();
    if (existing.data) return { ok: true, deduped: true };

    const wallet = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", userId)
      .eq("currency", data.currency)
      .maybeSingle();
    if (wallet.error) throw new Error(wallet.error.message);
    const current = Number(wallet.data?.balance ?? 0);
    const next = current + data.amount;

    const upd = await supabase
      .from("wallets")
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("currency", data.currency);
    if (upd.error) throw new Error(upd.error.message);

    const tx = await supabase.from("transactions").insert({
      user_id: userId,
      type: "deposit",
      currency: data.currency,
      amount: data.amount,
      status: "pending",
      reference: data.reference,
      description: `Bank deposit — awaiting admin verification`,
      proof_url: data.proofUrl,
    }).select("id").maybeSingle();
    if (tx.error) throw new Error(tx.error.message);

    // Create a locked tranche that matures in 30 days
    const maturity = new Date(Date.now() + 30 * 864e5).toISOString();
    const trancheIns = await supabase.from("deposit_tranches").insert({
      user_id: userId,
      currency: data.currency,
      amount: data.amount,
      remaining: data.amount,
      current_balance: data.amount,
      status: "locked",
      source: "deposit",
      transaction_id: tx.data?.id ?? null,
      maturity_date: maturity,
      approved: false,
    });
    if (trancheIns.error) throw new Error(trancheIns.error.message);
    return { ok: true, balance: next };
  });

export const requestWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { amount: number; currency: string; bankName?: string; accountNumber?: string; confirmBreak?: boolean }) =>
    z
      .object({
        amount: z.number().positive().max(10_000_000),
        currency: z.enum(CURRENCIES),
        bankName: z.string().max(200).optional(),
        accountNumber: z.string().max(100).optional(),
        confirmBreak: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const profile = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (!profile.data) throw new Error("Profile not found");

    const wallet = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", userId)
      .eq("currency", data.currency)
      .maybeSingle();
    const current = Number(wallet.data?.balance ?? 0);
    if (current < data.amount) throw new Error("Insufficient balance");

    // Withdraw matured funds first; if the user confirms breaking a cycle, use locked funds too.
    const tranchesRes = await supabase
      .from("deposit_tranches")
      .select("*")
      .eq("user_id", userId)
      .eq("currency", data.currency)
      .gt("remaining", 0)
      .order("created_at");
    const tranches = tranchesRes.data ?? [];
    const now = Date.now();
    const matured = tranches.filter((t: any) => new Date(t.maturity_date).getTime() <= now);
    const locked = tranches.filter((t: any) => new Date(t.maturity_date).getTime() > now);
    const lockedRemaining = locked.reduce((s: number, t: any) => s + Number(t.remaining), 0);
    const withdrawable = current - lockedRemaining;

    if (data.amount > withdrawable && !data.confirmBreak) {
      throw new Error("BREAKS_TRANCHE");
    }

    let remainingToWithdraw = data.amount;

    const updateTranche = async (t: any, currentValueTake: number) => {
      const principal = Number(t.remaining);
      const currentValue = Number(t.current_balance ?? t.remaining);
      const ratio = currentValue > 0 ? currentValueTake / currentValue : 1;
      const principalTake = Math.min(principal, Math.round(principal * ratio * 100) / 100);
      await supabase
        .from("deposit_tranches")
        .update({
          remaining: Math.max(0, principal - principalTake),
          current_balance: Math.max(0, currentValue - currentValueTake),
        })
        .eq("id", t.id);
    };

    for (const tranche of matured) {
      if (remainingToWithdraw <= 0) break;
      const currentValue = Number(tranche.current_balance ?? tranche.remaining);
      const take = Math.min(currentValue, remainingToWithdraw);
      if (take <= 0) continue;
      await updateTranche(tranche, take);
      remainingToWithdraw -= take;
    }

    if (data.amount <= withdrawable) {
      remainingToWithdraw = 0;
    } else if (remainingToWithdraw > 0 && data.confirmBreak) {
      // User confirmed breaking tranche; try to deduct from growing tranches.
      // We MUST forfeit growth for any tranche we touch here to keep wallet balance in sync with principal.
      let lockedNeed = remainingToWithdraw;
      for (const tranche of locked) {
        if (lockedNeed <= 0) break;
        const principal = Number(tranche.remaining);
        if (principal <= 0) continue;

        // Reset current_balance to remaining (principal) - forfeiting accumulated growth
        await supabase
          .from("deposit_tranches")
          .update({ current_balance: principal })
          .eq("id", tranche.id);

        const take = Math.min(principal, lockedNeed);
        await updateTranche({ ...tranche, remaining: principal, current_balance: principal }, take);
        lockedNeed -= take;
      }
      remainingToWithdraw = Math.max(0, lockedNeed);
    }

    if (remainingToWithdraw > 0) {
      throw new Error("Unable to withdraw requested amount");
    }

    const tx = await supabase.from("transactions").insert({
      user_id: userId,
      type: "withdrawal",
      currency: data.currency,
      amount: data.amount,
      status: "pending",
      description: `Withdrawal request — Bank: ${data.bankName ?? "n/a"} · Acc: ${data.accountNumber ?? "n/a"}`,
    });
    if (tx.error) throw new Error(tx.error.message);

    // Reserve the funds immediately
    await supabase
      .from("wallets")
      .update({ balance: current - data.amount, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("currency", data.currency);

    // Notify admin (background — best effort)
    const p = profile.data;
    const body =
      `New withdrawal request\n\n` +
      `User ID (Account): ${p.account_id}\n` +
      `Name: ${p.first_name} ${p.surname}\n` +
      `Email: ${p.email}\n` +
      `Phone: ${p.phone}\n` +
      `Amount: ${data.currency} ${data.amount.toFixed(2)}\n` +
      `Bank name: ${data.bankName ?? "(not provided)"}\n` +
      `Account number: ${data.accountNumber ?? "(not provided)"}\n`;
    await sendEmail(ADMIN_EMAIL, `Withdrawal request — ${p.account_id}`, body);

    return { ok: true };
  });

export const sendOtps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Consume any old codes
    await supabase.from("otp_codes").update({ consumed: true }).eq("user_id", userId).eq("consumed", false);
    const emailCode = Math.floor(100000 + Math.random() * 900000).toString();
    const { error } = await supabase.from("otp_codes").insert([
      { user_id: userId, channel: "email", code: emailCode },
    ]);
    if (error) throw new Error(error.message);

    const profile = await supabase.from("profiles").select("email, first_name").eq("id", userId).maybeSingle();
    const recipient = profile.data?.email;
    let delivered = false;
    if (recipient) {
      const r = await sendEmail(
        recipient,
        "Your Sparkle Insure verification code",
        `Hi ${profile.data?.first_name ?? ""},\n\nYour Sparkle Insure verification code is: ${emailCode}\n\nThis code expires shortly. If you did not request it, please ignore this email.`,
      );
      delivered = r.ok;
    }
    return { ok: true, delivered };
  });

export const verifyOtps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { emailCode: string }) =>
    z.object({ emailCode: z.string().length(6) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const codes = await supabase
      .from("otp_codes")
      .select("*")
      .eq("user_id", userId)
      .eq("consumed", false)
      .eq("channel", "email");
    if (codes.error) throw new Error(codes.error.message);
    const email = codes.data?.find((c) => c.channel === "email");
    if (!email) throw new Error("No verification code pending. Please resend.");
    if (email.code !== data.emailCode) throw new Error("Verification code is incorrect.");

    await supabase.from("otp_codes").update({ consumed: true }).eq("id", email.id);
    const upd = await supabase.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true };
  });