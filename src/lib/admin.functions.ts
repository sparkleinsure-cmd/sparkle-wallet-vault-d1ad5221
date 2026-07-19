import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CURRENCIES = ["ZAR", "USD"] as const;

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
    const profile = await context.supabase
      .from("profiles")
      .select("*")
      .eq("account_id", data.accountId.toUpperCase())
      .maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    if (!profile.data) return { profile: null, wallets: [], transactions: [] };
    const [wallets, txs, tranches] = await Promise.all([
      context.supabase.from("wallets").select("*").eq("user_id", profile.data.id).order("currency"),
      context.supabase
        .from("transactions")
        .select("*")
        .eq("user_id", profile.data.id)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("deposit_tranches")
        .select("*")
        .eq("user_id", profile.data.id)
        .gt("remaining", 0)
        .order("created_at"),
    ]);
    return {
      profile: profile.data,
      wallets: wallets.data ?? [],
      transactions: txs.data ?? [],
      tranches: tranches.data ?? [],
    };
  });

export const adminCreditBonus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; currency: string; amount: number; note?: string; holdRule: "attach" | "instant"; parentTrancheId?: string }) =>
    z
      .object({
        accountId: z.string().min(3).max(20),
        currency: z.enum(CURRENCIES),
        amount: z.number().positive().max(1_000_000),
        note: z.string().max(200).optional(),
        holdRule: z.enum(["attach", "instant"]),
        parentTrancheId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const profile = await context.supabase
      .from("profiles")
      .select("id")
      .eq("account_id", data.accountId.toUpperCase())
      .maybeSingle();
    if (!profile.data) throw new Error("Account not found");
    const uid = profile.data.id;

    let maturity = new Date().toISOString();
    let parentId: string | null = null;
    if (data.holdRule === "attach") {
      if (!data.parentTrancheId) throw new Error("Select a tranche to attach to");
      const parent = await context.supabase
        .from("deposit_tranches")
        .select("*")
        .eq("id", data.parentTrancheId)
        .eq("user_id", uid)
        .maybeSingle();
      if (!parent.data) throw new Error("Tranche not found");
      maturity = parent.data.maturity_date;
      parentId = parent.data.id;
    }

    const wallet = await context.supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", uid)
      .eq("currency", data.currency)
      .maybeSingle();
    const current = Number(wallet.data?.balance ?? 0);
    const next = current + data.amount;

    if (wallet.data) {
      await context.supabase
        .from("wallets")
        .update({ balance: next, updated_at: new Date().toISOString() })
        .eq("user_id", uid)
        .eq("currency", data.currency);
    } else {
      await context.supabase.from("wallets").insert({ user_id: uid, currency: data.currency, balance: next });
    }
    const tx = await context.supabase.from("transactions").insert({
      user_id: uid,
      type: "bonus",
      currency: data.currency,
      amount: data.amount,
      status: "completed",
      description: (data.note ?? "Bonus credit from admin") + (data.holdRule === "attach" ? " (attached to tranche)" : " (instant release)"),
    }).select("id").maybeSingle();

    await context.supabase.from("deposit_tranches").insert({
      user_id: uid,
      currency: data.currency,
      amount: data.amount,
      remaining: data.amount,
      current_balance: data.amount,
      status: data.holdRule === "instant" ? "matured" : "locked",
      source: "bonus",
      parent_tranche_id: parentId,
      transaction_id: tx.data?.id ?? null,
      note: data.note ?? null,
      maturity_date: maturity,
    });
    return { ok: true, balance: next };
  });

export const adminListActiveTranches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; currency: string }) =>
    z.object({
      accountId: z.string().min(3).max(20),
      currency: z.enum(CURRENCIES),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const profile = await context.supabase
      .from("profiles")
      .select("id")
      .eq("account_id", data.accountId.toUpperCase())
      .maybeSingle();
    if (!profile.data) return { tranches: [] };
    const now = new Date().toISOString();
    const t = await context.supabase
      .from("deposit_tranches")
      .select("*")
      .eq("user_id", profile.data.id)
      .eq("currency", data.currency)
      .gt("remaining", 0)
      .gt("maturity_date", now)
      .order("created_at");
    return { tranches: t.data ?? [] };
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
      { first: "Thabo", last: "Mokoena", phone: "+27821110002", ccy: "ZAR", bal: 18450 },
      { first: "Sarah", last: "Johnson", phone: "+14155550104", ccy: "USD", bal: 3120 },
      { first: "Linda", last: "Naidoo", phone: "+27831110005", ccy: "ZAR", bal: 62400 },
      { first: "Michael", last: "Van Wyk", phone: "+27831110006", ccy: "ZAR", bal: 9840 },
      { first: "Emily", last: "Carter", phone: "+14155550107", ccy: "USD", bal: 1560 },
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
        { user_id: uid, type: "deposit", currency: d.ccy, amount: d.bal * 0.3, status: "completed", description: "Bank deposit top-up", reference: `SEED-${uid}-2`, created_at: new Date(now - 10 * 864e5).toISOString() },
        { user_id: uid, type: "bonus", currency: d.ccy, amount: d.bal * 0.1, status: "completed", description: "Welcome bonus", created_at: new Date(now - 5 * 864e5).toISOString() },
        { user_id: uid, type: "withdrawal", currency: d.ccy, amount: d.bal * 0.05, status: "completed", description: "Payout", created_at: new Date(now - 2 * 864e5).toISOString() },
      ];
      await supabaseAdmin.from("transactions").insert(txRows as any);
      count++;
    }
    return { ok: true, seeded: count };
  });

export const adminListPendingDeposits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const txs = await context.supabase
      .from("transactions")
      .select("*")
      .eq("type", "deposit")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100);
    if (txs.error) throw new Error(txs.error.message);
    const userIds = Array.from(new Set((txs.data ?? []).map((t) => t.user_id)));
    let profilesById: Record<string, any> = {};
    if (userIds.length) {
      const p = await context.supabase
        .from("profiles")
        .select("id, account_id, first_name, surname, email")
        .in("id", userIds);
      profilesById = Object.fromEntries((p.data ?? []).map((x) => [x.id, x]));
    }
    const deposits = (txs.data ?? []).map((t) => ({ ...t, profiles: profilesById[t.user_id] ?? null }));
    return { deposits };
  });

export const adminGetProofUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { path: string }) => z.object({ path: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: signed, error } = await context.supabase.storage
      .from("deposits")
      .createSignedUrl(data.path, 300);
    if (error) throw new Error(error.message);
    return { url: signed.signedUrl };
  });

export const adminVerifyDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { txId: string; correctedAmount?: number; note?: string }) =>
    z.object({
      txId: z.string().uuid(),
      correctedAmount: z.number().positive().max(10_000_000).optional(),
      note: z.string().max(300).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const tx = await context.supabase
      .from("transactions")
      .select("*")
      .eq("id", data.txId)
      .maybeSingle();
    if (tx.error || !tx.data) throw new Error("Transaction not found");
    if (tx.data.status !== "pending") throw new Error("Already processed");

    const original = Number(tx.data.amount);
    const corrected = data.correctedAmount ?? original;
    const delta = corrected - original;

    // Mark deposit tx completed at original amount, add adjustment tx for delta
    await context.supabase
      .from("transactions")
      .update({ status: "completed", description: `Deposit verified by admin${data.note ? ` — ${data.note}` : ""}` })
      .eq("id", data.txId);

    // Approve the linked tranche and reset the 30-day cycle to start from approval
    const approvedAt = new Date();
    const newMaturity = new Date(approvedAt.getTime() + 30 * 864e5).toISOString();
    await context.supabase
      .from("deposit_tranches")
      .update({
        approved: true,
        created_at: approvedAt.toISOString(),
        maturity_date: newMaturity,
      })
      .eq("transaction_id", data.txId);

    if (delta !== 0) {
      const wallet = await context.supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", tx.data.user_id)
        .eq("currency", tx.data.currency)
        .maybeSingle();
      const current = Number(wallet.data?.balance ?? 0);
      await context.supabase
        .from("wallets")
        .update({ balance: current + delta, updated_at: new Date().toISOString() })
        .eq("user_id", tx.data.user_id)
        .eq("currency", tx.data.currency);

      // Adjust the tranche principal to the corrected amount
      await context.supabase
        .from("deposit_tranches")
        .update({ amount: corrected, remaining: corrected, current_balance: corrected })
        .eq("transaction_id", data.txId);

      await context.supabase.from("transactions").insert({
        user_id: tx.data.user_id,
        type: "adjustment",
        currency: tx.data.currency,
        amount: delta,
        status: "completed",
        reference: tx.data.reference,
        description: `Admin correction on deposit${data.note ? ` — ${data.note}` : ""}`,
      });
    }
    return { ok: true, delta };
  });

export const adminDeclineDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { txId: string; reason?: string }) =>
    z.object({ txId: z.string().uuid(), reason: z.string().max(300).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const tx = await context.supabase
      .from("transactions")
      .select("*")
      .eq("id", data.txId)
      .maybeSingle();
    if (tx.error || !tx.data) throw new Error("Transaction not found");
    if (tx.data.type !== "deposit") throw new Error("Not a deposit");
    if (tx.data.status !== "pending") throw new Error("Already processed");

    const amount = Number(tx.data.amount);

    // Remove the tranche created for this deposit
    await context.supabase
      .from("deposit_tranches")
      .delete()
      .eq("transaction_id", data.txId);

    // Reverse the wallet credit
    const wallet = await context.supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", tx.data.user_id)
      .eq("currency", tx.data.currency)
      .maybeSingle();
    const current = Number(wallet.data?.balance ?? 0);
    await context.supabase
      .from("wallets")
      .update({ balance: Math.max(0, current - amount), updated_at: new Date().toISOString() })
      .eq("user_id", tx.data.user_id)
      .eq("currency", tx.data.currency);

    // Mark the deposit tx as declined
    await context.supabase
      .from("transactions")
      .update({
        status: "declined" as any,
        description: `Deposit declined by admin${data.reason ? ` — ${data.reason}` : ""}`,
      })
      .eq("id", data.txId);

    return { ok: true };
  });

export const adminListPendingWithdrawals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const txs = await context.supabase
      .from("transactions")
      .select("*")
      .eq("type", "withdrawal")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200);
    if (txs.error) throw new Error(txs.error.message);
    const userIds = Array.from(new Set((txs.data ?? []).map((t) => t.user_id)));
    let profilesById: Record<string, any> = {};
    if (userIds.length) {
      const p = await context.supabase
        .from("profiles")
        .select("id, account_id, first_name, surname, email, phone")
        .in("id", userIds);
      profilesById = Object.fromEntries((p.data ?? []).map((x) => [x.id, x]));
    }
    const withdrawals = (txs.data ?? []).map((t) => ({ ...t, profiles: profilesById[t.user_id] ?? null }));
    return { withdrawals };
  });

export const adminCompleteWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { txId: string; note?: string }) =>
    z.object({ txId: z.string().uuid(), note: z.string().max(300).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const tx = await context.supabase
      .from("transactions")
      .select("*")
      .eq("id", data.txId)
      .maybeSingle();
    if (tx.error || !tx.data) throw new Error("Withdrawal not found");
    if (tx.data.type !== "withdrawal") throw new Error("Not a withdrawal");
    if (tx.data.status !== "pending") throw new Error("Already processed");
    const upd = await context.supabase
      .from("transactions")
      .update({
        status: "completed",
        description: `Withdrawal approved - Paid${data.note ? ` — ${data.note}` : ""}`,
      })
      .eq("id", data.txId);
    if (upd.error) throw new Error(upd.error.message);
    return { ok: true };
  });
