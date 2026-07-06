import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CURRENCIES = ["ZAR", "NGN", "GHS", "USD"] as const;

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const adminLookupUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) =>
    z.object({ accountId: z.string().trim().min(3).max(20) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const profile = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("account_id", data.accountId.toUpperCase())
      .maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    if (!profile.data) return { profile: null, wallets: [], transactions: [] };
    const [wallets, txs] = await Promise.all([
      supabaseAdmin.from("wallets").select("*").eq("user_id", profile.data.id).order("currency"),
      supabaseAdmin
        .from("transactions")
        .select("*")
        .eq("user_id", profile.data.id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    return {
      profile: profile.data,
      wallets: wallets.data ?? [],
      transactions: txs.data ?? [],
    };
  });

export const adminCreditBonus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; currency: string; amount: number; note?: string }) =>
    z
      .object({
        accountId: z.string().min(3).max(20),
        currency: z.enum(CURRENCIES),
        amount: z.number().positive().max(1_000_000),
        note: z.string().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const profile = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("account_id", data.accountId.toUpperCase())
      .maybeSingle();
    if (!profile.data) throw new Error("Account not found");
    const uid = profile.data.id;

    const wallet = await supabaseAdmin
      .from("wallets")
      .select("balance")
      .eq("user_id", uid)
      .eq("currency", data.currency)
      .maybeSingle();
    const current = Number(wallet.data?.balance ?? 0);
    const next = current + data.amount;

    if (wallet.data) {
      await supabaseAdmin
        .from("wallets")
        .update({ balance: next, updated_at: new Date().toISOString() })
        .eq("user_id", uid)
        .eq("currency", data.currency);
    } else {
      await supabaseAdmin.from("wallets").insert({ user_id: uid, currency: data.currency, balance: next });
    }
    await supabaseAdmin.from("transactions").insert({
      user_id: uid,
      type: "bonus",
      currency: data.currency,
      amount: data.amount,
      status: "completed",
      description: data.note ?? "Bonus credit from admin",
    });
    return { ok: true, balance: next };
  });

export const adminSeedDemo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const existing = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .like("email", "demo%@sparkleinsure.demo");
    if ((existing.count ?? 0) >= 5) return { ok: true, seeded: 0 };

    const demos = [
      { first: "Amara", last: "Okafor", phone: "+2348012345001", ccy: "NGN", bal: 425000 },
      { first: "Thabo", last: "Mokoena", phone: "+27821110002", ccy: "ZAR", bal: 18450 },
      { first: "Kwame", last: "Mensah", phone: "+233241110003", ccy: "GHS", bal: 9200 },
      { first: "Sarah", last: "Johnson", phone: "+14155550104", ccy: "USD", bal: 3120 },
      { first: "Linda", last: "Naidoo", phone: "+27831110005", ccy: "ZAR", bal: 62400 },
    ] as const;

    let count = 0;
    for (let i = 0; i < demos.length; i++) {
      const d = demos[i];
      const email = `demo${i + 1}@sparkleinsure.demo`;
      const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: `Demo!${Math.random().toString(36).slice(2, 10)}Aa1`,
        email_confirm: true,
        user_metadata: {
          first_name: d.first,
          surname: d.last,
          phone: d.phone,
          primary_currency: d.ccy,
        },
      });
      if (error || !created?.user) {
        console.error("seed error", error);
        continue;
      }
      const uid = created.user.id;
      // Mark KYC verified & seed balance + transactions
      await supabaseAdmin.from("profiles").update({ kyc_status: "verified" }).eq("id", uid);
      await supabaseAdmin
        .from("wallets")
        .update({ balance: d.bal })
        .eq("user_id", uid)
        .eq("currency", d.ccy);

      const now = Date.now();
      const txRows = [
        { user_id: uid, type: "deposit", currency: d.ccy, amount: d.bal * 0.6, status: "completed", description: "Opening deposit", reference: `SEED-${uid}-1`, created_at: new Date(now - 20 * 864e5).toISOString() },
        { user_id: uid, type: "deposit", currency: d.ccy, amount: d.bal * 0.3, status: "completed", description: "Paystack top-up", reference: `SEED-${uid}-2`, created_at: new Date(now - 10 * 864e5).toISOString() },
        { user_id: uid, type: "bonus", currency: d.ccy, amount: d.bal * 0.1, status: "completed", description: "Welcome bonus", created_at: new Date(now - 5 * 864e5).toISOString() },
        { user_id: uid, type: "withdrawal", currency: d.ccy, amount: d.bal * 0.05, status: "completed", description: "Payout", created_at: new Date(now - 2 * 864e5).toISOString() },
      ];
      await supabaseAdmin.from("transactions").insert(txRows as any);
      count++;
    }
    return { ok: true, seeded: count };
  });