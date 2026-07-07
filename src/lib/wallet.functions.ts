import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CURRENCIES = ["ZAR", "NGN", "GHS", "USD"] as const;

export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [profileRes, walletsRes, txRes, rolesRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabase.from("wallets").select("*").eq("user_id", userId).order("currency"),
      supabase.from("transactions").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabase.from("user_roles").select("role").eq("user_id", userId),
    ]);
    if (profileRes.error) throw new Error(profileRes.error.message);
    return {
      profile: profileRes.data,
      wallets: walletsRes.data ?? [],
      transactions: txRes.data ?? [],
      roles: (rolesRes.data ?? []).map((r) => r.role as string),
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
    });
    if (tx.error) throw new Error(tx.error.message);
    return { ok: true, balance: next };
  });

export const requestWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { amount: number; currency: string; bankDetails?: string }) =>
    z
      .object({
        amount: z.number().positive().max(10_000_000),
        currency: z.enum(CURRENCIES),
        bankDetails: z.string().max(500).optional(),
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

    const tx = await supabase.from("transactions").insert({
      user_id: userId,
      type: "withdrawal",
      currency: data.currency,
      amount: data.amount,
      status: "pending",
      description: "Withdrawal request",
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
    const body = `New withdrawal request\n\nAccount: ${p.account_id}\nName: ${p.first_name} ${p.surname}\nEmail: ${p.email}\nPhone: ${p.phone}\nAmount: ${data.currency} ${data.amount.toFixed(2)}\nBank details: ${data.bankDetails ?? "(on file)"}\n`;
    try {
      const resendKey = process.env.RESEND_API_KEY;
      const lovableKey = process.env.LOVABLE_API_KEY;
      if (resendKey && lovableKey) {
        await fetch("https://connector-gateway.lovable.dev/resend/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lovableKey}`,
            "X-Connection-Api-Key": resendKey,
          },
          body: JSON.stringify({
            from: "Sparkle Insure <onboarding@resend.dev>",
            to: ["sparkleinsure@gmail.com"],
            subject: `Withdrawal request — ${p.account_id}`,
            text: body,
          }),
        });
      } else {
        console.log("[withdrawal:notify]", body);
      }
    } catch (err) {
      console.error("[withdrawal:notify:error]", err);
    }

    return { ok: true };
  });

export const sendOtps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Consume any old codes
    await supabase.from("otp_codes").update({ consumed: true }).eq("user_id", userId).eq("consumed", false);
    const emailCode = Math.floor(100000 + Math.random() * 900000).toString();
    const phoneCode = Math.floor(100000 + Math.random() * 900000).toString();
    const { error } = await supabase.from("otp_codes").insert([
      { user_id: userId, channel: "email", code: emailCode },
      { user_id: userId, channel: "phone", code: phoneCode },
    ]);
    if (error) throw new Error(error.message);
    // In production the codes would be sent via Email/SMS; we return them so
    // the UI can show a "development delivery" notice (simulated).
    return { ok: true, emailCode, phoneCode };
  });

export const verifyOtps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { emailCode: string; phoneCode: string }) =>
    z.object({ emailCode: z.string().length(6), phoneCode: z.string().length(6) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const codes = await supabase
      .from("otp_codes")
      .select("*")
      .eq("user_id", userId)
      .eq("consumed", false);
    if (codes.error) throw new Error(codes.error.message);
    const email = codes.data?.find((c) => c.channel === "email");
    const phone = codes.data?.find((c) => c.channel === "phone");
    if (!email || !phone) throw new Error("No OTP pending. Please resend.");
    if (email.code !== data.emailCode) throw new Error("Email OTP is incorrect.");
    if (phone.code !== data.phoneCode) throw new Error("Phone OTP is incorrect.");

    await supabase.from("otp_codes").update({ consumed: true }).in("id", [email.id, phone.id]);
    const upd = await supabase.from("profiles").update({ kyc_status: "verified" }).eq("id", userId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true };
  });