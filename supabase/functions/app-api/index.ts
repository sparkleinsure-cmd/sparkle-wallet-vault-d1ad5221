import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CURRENCIES = new Set(["ZAR", "USD"]);
const ADMIN_EMAIL = "sparkleinsure@gmail.com";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

function requireCurrency(value: unknown): "ZAR" | "USD" {
  if (typeof value !== "string" || !CURRENCIES.has(value)) throw new Error("Invalid currency");
  return value as "ZAR" | "USD";
}

function requireAmount(value: unknown, max = 10_000_000): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > max) throw new Error("Invalid amount");
  return amount;
}

function requireString(value: unknown, field: string, min = 1, max = 500): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Error(`Invalid ${field}`);
  return trimmed;
}

async function sendEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const from = Deno.env.get("RESEND_FROM_EMAIL") ?? "Sparkle Insure <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!response.ok) console.error("Resend request failed", response.status, await response.text());
  return response.ok;
}

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("Unauthorized");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error("Supabase function secrets are not configured");

    const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) throw new Error("Unauthorized");
    const userId = auth.user.id;
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action : "";
    const data = body?.data ?? {};

    switch (action) {
      case "getMe": {
        const [profileRes, walletsRes, txRes, rolesRes, tranchesRes] = await Promise.all([
          supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
          supabase.from("wallets").select("*").eq("user_id", userId).order("currency"),
          supabase.from("transactions").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
          supabase.from("user_roles").select("role").eq("user_id", userId),
          supabase.from("deposit_tranches").select("*").eq("user_id", userId).gt("remaining", 0).order("created_at"),
        ]);
        if (profileRes.error) throw new Error(profileRes.error.message);
        return json({ data: { profile: profileRes.data, wallets: walletsRes.data ?? [], transactions: txRes.data ?? [], roles: (rolesRes.data ?? []).map((r: any) => r.role), tranches: tranchesRes.data ?? [] } });
      }

      case "getAccountHealth": {
        const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
        const [snapshots, rewards] = await Promise.all([
          supabase.from("wallet_health_daily").select("snapshot_date, wallet_value_zar, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties, reward_credit").eq("user_id", userId).gte("snapshot_date", since).order("snapshot_date"),
          supabase.from("wallet_reward_credits").select("points, value, qualifying_date").eq("user_id", userId).order("qualifying_date", { ascending: false }).limit(20),
        ]);
        if (snapshots.error) throw new Error(snapshots.error.message);
        if (rewards.error) throw new Error(rewards.error.message);
        const profile = await supabase.from("profiles").select("reward_points, reward_streak_days").eq("id", userId).maybeSingle();
        if (profile.error) throw new Error(profile.error.message);
        return json({ data: { snapshots: snapshots.data ?? [], rewards: rewards.data ?? [], points: profile.data?.reward_points ?? 0, streakDays: profile.data?.reward_streak_days ?? 0 } });
      }

      case "getStatementTransactions": {
        const days = Number(data.days);
        if (![7, 30, 90].includes(days)) throw new Error("Invalid statement period");
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const transactions: unknown[] = [];
        for (let from = 0; ; from += 1_000) {
          const { data: page, error } = await supabase.from("transactions").select("id, type, currency, amount, status, description, created_at").eq("user_id", userId).gte("created_at", cutoff).order("created_at", { ascending: false }).range(from, from + 999);
          if (error) throw new Error(error.message);
          transactions.push(...(page ?? []));
          if (!page || page.length < 1_000) break;
        }
        return json({ data: transactions });
      }

      case "setPrimaryCurrency": {
        const currency = requireCurrency(data.currency);
        const { error } = await supabase.rpc("set_primary_currency_secure", { p_currency: currency });
        if (error) throw new Error(error.message);
        return json({ data: { ok: true } });
      }

      case "setPayoutDetails": {
        const bankName = requireString(data.bankName, "bank name", 2, 100);
        const accountNumber = requireString(data.accountNumber, "account number", 4, 40);
        const { error } = await supabase.rpc("set_registered_payout_details", {
          p_bank_name: bankName,
          p_account_number: accountNumber,
        });
        if (error) throw new Error(error.message);
        return json({ data: { ok: true } });
      }

      case "requestPayoutDetailsChange": {
        const result = await supabase.rpc("request_payout_details_change");
        if (result.error) throw new Error(result.error.message);
        return json({ data: { availableAt: result.data } });
      }

      case "updateProfileContact": {
        const phone = requireString(data.phone, "phone number", 8, 30);
        const streetAddress = requireString(data.streetAddress, "street address", 3, 150);
        const province = requireString(data.province, "province", 2, 80);
        const postalCode = requireString(data.postalCode, "postal code", 3, 10);
        const result = await supabase.rpc("update_profile_contact", {
          p_phone: phone, p_street_address: streetAddress, p_province: province, p_postal_code: postalCode,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "creditDeposit": {
        const amount = requireAmount(data.amount);
        const currency = requireCurrency(data.currency);
        const reference = requireString(data.reference, "reference", 3, 200);
        const proofUrl = requireString(data.proofUrl, "proof", 3, 500);
        const secureDeposit = await supabase.rpc("submit_deposit_secure", {
          p_amount: amount, p_currency: currency, p_reference: reference, p_proof_path: proofUrl,
        });
        if (secureDeposit.error) throw new Error(secureDeposit.error.message);
        return json({ data: { ok: true, transactionId: secureDeposit.data, status: "pending" } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const existing = await supabase.from("transactions").select("id").eq("reference", reference).eq("user_id", userId).maybeSingle();
        if (existing.data) return json({ data: { ok: true, deduped: true } });
        const wallet = await supabase.from("wallets").select("balance").eq("user_id", userId).eq("currency", currency).maybeSingle();
        if (wallet.error) throw new Error(wallet.error.message);
        const next = Number(wallet.data?.balance ?? 0) + amount;
        const walletUpdate = await supabase.from("wallets").update({ balance: next, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("currency", currency);
        if (walletUpdate.error) throw new Error(walletUpdate.error.message);
        const tx = await supabase.from("transactions").insert({ user_id: userId, type: "deposit", currency, amount, status: "pending", reference, description: "Bank deposit — awaiting admin verification", proof_url: proofUrl }).select("id").maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        const tranche = await supabase.from("deposit_tranches").insert({ user_id: userId, currency, amount, remaining: amount, current_balance: amount, status: "locked", source: "deposit", transaction_id: tx.data?.id ?? null, maturity_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), approved: false });
        if (tranche.error) throw new Error(tranche.error.message);
        return json({ data: { ok: true, balance: next } });
      }

      case "requestWithdrawal": {
        const amount = requireAmount(data.amount);
        const currency = requireCurrency(data.currency);
        const secureWithdrawal = await supabase.rpc("request_withdrawal_secure", {
          p_amount: amount, p_currency: currency, p_bank_name: null,
          p_account_number: null, p_confirm_break: data.confirmBreak === true,
        });
        if (secureWithdrawal.error) throw new Error(secureWithdrawal.error.message);
        return json({ data: { ok: true, ...(secureWithdrawal.data ?? {}) } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const profile = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
        if (!profile.data) throw new Error("Profile not found");
        const wallet = await supabase.from("wallets").select("balance").eq("user_id", userId).eq("currency", currency).maybeSingle();
        const current = Number(wallet.data?.balance ?? 0);
        if (current < amount) throw new Error("Insufficient balance");
        const tranchesRes = await supabase.from("deposit_tranches").select("*").eq("user_id", userId).eq("currency", currency).gt("remaining", 0).order("created_at");
        if (tranchesRes.error) throw new Error(tranchesRes.error.message);
        const now = Date.now();
        const matured = (tranchesRes.data ?? []).filter((t: any) => new Date(t.maturity_date).getTime() <= now);
        const locked = (tranchesRes.data ?? []).filter((t: any) => new Date(t.maturity_date).getTime() > now);
        const withdrawable = current - locked.reduce((sum: number, t: any) => sum + Number(t.remaining), 0);
        if (amount > withdrawable && !data.confirmBreak) throw new Error("BREAKS_TRANCHE");
        let remaining = amount;
        const consume = async (tranche: any, take: number) => {
          const principal = Number(tranche.remaining);
          const value = Number(tranche.current_balance ?? tranche.remaining);
          const principalTake = Math.min(principal, Math.round(principal * (value > 0 ? take / value : 1) * 100) / 100);
          const nextRemaining = Math.max(0, principal - principalTake);
          const nextValue = Math.max(0, value - take);
          const { error } = await supabase.from("deposit_tranches").update({ remaining: nextRemaining, current_balance: nextValue, ...(nextValue === 0 ? { status: "liquidated" } : {}) }).eq("id", tranche.id);
          if (error) throw new Error(error.message);
        };
        for (const tranche of matured) { if (remaining <= 0) break; const take = Math.min(Number(tranche.current_balance ?? tranche.remaining), remaining); if (take > 0) { await consume(tranche, take); remaining -= take; } }
        if (amount <= withdrawable) remaining = 0;
        if (remaining > 0 && data.confirmBreak) for (const tranche of locked) { if (remaining <= 0) break; const take = Math.min(Number(tranche.current_balance ?? tranche.remaining), remaining); if (take > 0) { await consume(tranche, take); remaining -= take; } }
        if (remaining > 0) throw new Error("Unable to withdraw requested amount");
        const growingAmount = Math.max(0, amount - withdrawable);
        const penalty = Math.round(growingAmount * 0.05 * 100) / 100;
        const payoutAmount = Math.round((amount - penalty) * 100) / 100;
        const bankName = typeof data.bankName === "string" ? data.bankName.slice(0, 200) : "n/a";
        const accountNumber = typeof data.accountNumber === "string" ? data.accountNumber.slice(0, 100) : "n/a";
        const tx = await supabase.from("transactions").insert({ user_id: userId, type: "withdrawal", currency, amount: payoutAmount, status: "pending", description: `Withdrawal request — Bank: ${bankName} · Acc: ${accountNumber}` }).select("id").maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        if (penalty > 0) { const fee = await supabase.from("transactions").insert({ user_id: userId, type: "fee", currency, amount: penalty, status: "completed", description: `Early withdrawal penalty (5%) on ${currency} ${growingAmount.toFixed(2)}. Included in the gross withdrawal amount.`, reference: tx.data?.id ?? null }); if (fee.error) throw new Error(fee.error.message); }
        const walletUpdate = await supabase.from("wallets").update({ balance: current - amount, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("currency", currency);
        if (walletUpdate.error) throw new Error(walletUpdate.error.message);
        const p = profile.data;
        await sendEmail(ADMIN_EMAIL, `Withdrawal request — ${p.account_id}`, `New withdrawal request\n\nUser ID: ${p.account_id}\nName: ${p.first_name} ${p.surname}\nEmail: ${p.email}\nPhone: ${p.phone}\nGross withdrawal: ${currency} ${amount.toFixed(2)}\nEarly withdrawal penalty: ${currency} ${penalty.toFixed(2)}\nNet bank payout: ${currency} ${payoutAmount.toFixed(2)}\nBank: ${bankName}\nAccount: ${accountNumber}`);
        return json({ data: { ok: true, grossAmount: amount, penalty, payoutAmount } });
      }

      case "submitKycReview": {
        const bankProofPath = typeof data.bankProofPath === "string" ? requireString(data.bankProofPath, "banking proof", 3, 500) : null;
        const selfiePath = requireString(data.selfiePath, "selfie", 3, 500);
        const { error } = await supabase.rpc("submit_kyc_review", { p_proof_path: bankProofPath, p_selfie_path: selfiePath });
        if (error) throw new Error(error.message);
        return json({ data: { ok: true, status: "pending" } });
      }

      case "deleteMyAccount": {
        // Remove private files first; deleting the auth user then cascades the
        // profile, wallet, transaction, tranche, and role records.
        for (const bucket of ["kyc", "deposits"]) {
          const listed = await admin.storage.from(bucket).list(userId, { limit: 1000 });
          if (!listed.error && listed.data?.length) {
            await admin.storage.from(bucket).remove(listed.data.map((file) => `${userId}/${file.name}`));
          }
        }
        const deleted = await admin.auth.admin.deleteUser(userId, true);
        if (deleted.error) throw new Error(deleted.error.message);
        return json({ data: { ok: true } });
      }

      case "adminSetKycStatus": {
        await assertAdmin(supabase, userId);
        const targetUserId = requireString(data.userId, "user", 36, 36);
        const status = data.status === "verified" ? "verified" : data.status === "rejected" ? "rejected" : null;
        if (!status) throw new Error("Invalid status");
        const { error } = await supabase.rpc("admin_set_kyc_status", { p_user_id: targetUserId, p_status: status });
        if (error) throw new Error(error.message);
        return json({ data: { ok: true } });
      }

      case "adminListPendingKyc": {
        await assertAdmin(supabase, userId);
        const reviews = await supabase
          .from("profiles")
          .select("id, account_id, first_name, surname, email, phone, proof_url, selfie_url, created_at")
          .eq("kyc_status", "pending")
          .not("selfie_url", "is", null)
          .order("created_at", { ascending: false })
          .limit(100);
        if (reviews.error) throw new Error(reviews.error.message);
        return json({ data: { reviews: reviews.data ?? [] } });
      }

      case "adminGetUserCount": {
        await assertAdmin(supabase, userId);
        const result = await admin.from("profiles").select("id", { count: "exact", head: true });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { count: result.count ?? 0 } });
      }

      case "sendOtps": {
        await supabase.from("otp_codes").update({ consumed: true }).eq("user_id", userId).eq("consumed", false);
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const { error } = await supabase.from("otp_codes").insert({ user_id: userId, channel: "email", code });
        if (error) throw new Error(error.message);
        const profile = await supabase.from("profiles").select("email, first_name").eq("id", userId).maybeSingle();
        const delivered = profile.data?.email ? await sendEmail(profile.data.email, "Your Sparkle Insure verification code", `Hi ${profile.data.first_name ?? ""},\n\nYour Sparkle Insure verification code is: ${code}\n\nThis code expires shortly. If you did not request it, please ignore this email.`) : false;
        return json({ data: { ok: true, delivered } });
      }

      case "verifyOtps": {
        throw new Error("Identity reviews are approved by an administrator after document review");
      }

      case "adminLookupUser": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const profile = await supabase.from("profiles").select("*").eq("account_id", accountId).maybeSingle();
        if (profile.error) throw new Error(profile.error.message);
        if (!profile.data) return json({ data: { profile: null, wallets: [], transactions: [], tranches: [] } });
        const [wallets, transactions, tranches] = await Promise.all([
          supabase.from("wallets").select("*").eq("user_id", profile.data.id).order("currency"),
          supabase.from("transactions").select("*").eq("user_id", profile.data.id).order("created_at", { ascending: false }).limit(50),
          supabase.from("deposit_tranches").select("*").eq("user_id", profile.data.id).gt("remaining", 0).order("created_at"),
        ]);
        return json({ data: { profile: profile.data, wallets: wallets.data ?? [], transactions: transactions.data ?? [], tranches: tranches.data ?? [] } });
      }

      case "adminListActiveTranches": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const currency = requireCurrency(data.currency);
        const profile = await supabase.from("profiles").select("id").eq("account_id", accountId).maybeSingle();
        if (!profile.data) return json({ data: { tranches: [] } });
        const tranches = await supabase.from("deposit_tranches").select("*").eq("user_id", profile.data.id).eq("currency", currency).gt("remaining", 0).gt("maturity_date", new Date().toISOString()).order("created_at");
        if (tranches.error) throw new Error(tranches.error.message);
        return json({ data: { tranches: tranches.data ?? [] } });
      }

      case "adminCreditBonus": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const currency = requireCurrency(data.currency);
        const amount = requireAmount(data.amount, 1_000_000);
        const holdRule = data.holdRule === "attach" ? "attach" : data.holdRule === "instant" ? "instant" : null;
        if (!holdRule) throw new Error("Invalid hold rule");
        const profile = await supabase.from("profiles").select("id").eq("account_id", accountId).maybeSingle();
        if (!profile.data) throw new Error("Account not found");
        const targetId = profile.data.id;
        const secureCredit = await supabase.rpc("admin_credit_bonus_secure", {
          p_user_id: targetId, p_currency: currency, p_amount: amount,
          p_note: typeof data.note === "string" ? data.note.slice(0, 200) : null,
          p_hold_rule: holdRule, p_parent_tranche_id: holdRule === "attach" ? requireString(data.parentTrancheId, "tranche", 1, 100) : null,
        });
        if (secureCredit.error) throw new Error(secureCredit.error.message);
        return json({ data: { ok: true, balance: secureCredit.data } });

        /* Legacy flow retained below for historical source context; unreachable. */
        let maturityDate = new Date().toISOString(); let parentTrancheId: string | null = null;
        if (holdRule === "attach") { const parentId = requireString(data.parentTrancheId, "tranche", 1, 100); const parent = await supabase.from("deposit_tranches").select("*").eq("id", parentId).eq("user_id", targetId).maybeSingle(); if (!parent.data) throw new Error("Tranche not found"); maturityDate = parent.data.maturity_date; parentTrancheId = parent.data.id; }
        const wallet = await supabase.from("wallets").select("balance").eq("user_id", targetId).eq("currency", currency).maybeSingle();
        const balance = Number(wallet.data?.balance ?? 0) + amount;
        const walletWrite = wallet.data ? await supabase.from("wallets").update({ balance, updated_at: new Date().toISOString() }).eq("user_id", targetId).eq("currency", currency) : await supabase.from("wallets").insert({ user_id: targetId, currency, balance });
        if (walletWrite.error) throw new Error(walletWrite.error.message);
        const note = typeof data.note === "string" ? data.note.slice(0, 200) : "";
        const tx = await supabase.from("transactions").insert({ user_id: targetId, type: "bonus", currency, amount, status: "completed", description: `${note || "Bonus credit from admin"}${holdRule === "attach" ? " (attached to tranche)" : " (instant release)"}` }).select("id").maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        const tranche = await supabase.from("deposit_tranches").insert({ user_id: targetId, currency, amount, remaining: amount, current_balance: amount, status: holdRule === "instant" ? "matured" : "locked", source: "bonus", parent_tranche_id: parentTrancheId, transaction_id: tx.data?.id ?? null, note: note || null, maturity_date: maturityDate });
        if (tranche.error) throw new Error(tranche.error.message);
        return json({ data: { ok: true, balance } });
      }

      case "adminListPendingDeposits": {
        await assertAdmin(supabase, userId);
        const txs = await supabase.from("transactions").select("*").eq("type", "deposit").eq("status", "pending").order("created_at", { ascending: false }).limit(100);
        if (txs.error) throw new Error(txs.error.message);
        const ids = [...new Set((txs.data ?? []).map((t: any) => t.user_id))];
        const profiles = ids.length ? await supabase.from("profiles").select("id, account_id, first_name, surname, email").in("id", ids) : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({ data: { deposits: (txs.data ?? []).map((t: any) => ({ ...t, profiles: byId[t.user_id] ?? null })) } });
      }

      case "adminGetProofUrl": {
        await assertAdmin(supabase, userId);
        const path = requireString(data.path, "proof path", 1, 500);
        const signed = await supabase.storage.from("deposits").createSignedUrl(path, 300);
        if (signed.error) throw new Error(signed.error.message);
        return json({ data: { url: signed.data.signedUrl } });
      }

      case "adminGetKycProofUrl": {
        await assertAdmin(supabase, userId);
        const path = requireString(data.path, "verification file", 1, 500);
        // KYC files deliberately have no administrator storage policy. Create
        // a five-minute link with the server-only client after authorizing the
        // caller above, rather than making these sensitive files readable.
        const signed = await admin.storage.from("kyc").createSignedUrl(path, 300);
        if (signed.error) throw new Error(signed.error.message);
        return json({ data: { url: signed.data.signedUrl } });
      }

      case "adminVerifyDeposit": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const approved = await supabase.rpc("admin_approve_deposit_secure", {
          p_tx_id: txId, p_corrected_amount: data.correctedAmount == null ? null : requireAmount(data.correctedAmount),
          p_note: typeof data.note === "string" ? data.note.slice(0, 300) : null,
        });
        if (approved.error) throw new Error(approved.error.message);
        return json({ data: { ok: true, approvedAmount: approved.data } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.status !== "pending") throw new Error("Transaction not found or already processed");
        const corrected = data.correctedAmount == null ? Number(tx.data.amount) : requireAmount(data.correctedAmount);
        const delta = corrected - Number(tx.data.amount);
        const note = typeof data.note === "string" ? data.note.slice(0, 300) : "";
        const updated = await supabase.from("transactions").update({ status: "completed", description: `Deposit verified by admin${note ? ` — ${note}` : ""}` }).eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        await supabase.from("deposit_tranches").update({ approved: true, created_at: new Date().toISOString(), maturity_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...(delta !== 0 ? { amount: corrected, remaining: corrected, current_balance: corrected } : {}) }).eq("transaction_id", txId);
        if (delta !== 0) { const wallet = await supabase.from("wallets").select("balance").eq("user_id", tx.data.user_id).eq("currency", tx.data.currency).maybeSingle(); const next = Number(wallet.data?.balance ?? 0) + delta; const upd = await supabase.from("wallets").update({ balance: next, updated_at: new Date().toISOString() }).eq("user_id", tx.data.user_id).eq("currency", tx.data.currency); if (upd.error) throw new Error(upd.error.message); const adjustment = await supabase.from("transactions").insert({ user_id: tx.data.user_id, type: "adjustment", currency: tx.data.currency, amount: delta, status: "completed", reference: tx.data.reference, description: `Admin correction on deposit${note ? ` — ${note}` : ""}` }); if (adjustment.error) throw new Error(adjustment.error.message); }
        return json({ data: { ok: true, delta } });
      }

      case "adminDeclineDeposit": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const declined = await supabase.rpc("admin_decline_deposit_secure", {
          p_tx_id: txId, p_reason: typeof data.reason === "string" ? data.reason.slice(0, 300) : null,
        });
        if (declined.error) throw new Error(declined.error.message);
        return json({ data: { ok: true } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.type !== "deposit" || tx.data.status !== "pending") throw new Error("Transaction not found or already processed");
        const wallet = await supabase.from("wallets").select("balance").eq("user_id", tx.data.user_id).eq("currency", tx.data.currency).maybeSingle();
        const updatedWallet = await supabase.from("wallets").update({ balance: Math.max(0, Number(wallet.data?.balance ?? 0) - Number(tx.data.amount)), updated_at: new Date().toISOString() }).eq("user_id", tx.data.user_id).eq("currency", tx.data.currency);
        if (updatedWallet.error) throw new Error(updatedWallet.error.message);
        await supabase.from("deposit_tranches").delete().eq("transaction_id", txId);
        const reason = typeof data.reason === "string" ? data.reason.slice(0, 300) : "";
        const updated = await supabase.from("transactions").update({ status: "declined", description: `Deposit declined by admin${reason ? ` — ${reason}` : ""}` }).eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        return json({ data: { ok: true } });
      }

      case "adminListPendingWithdrawals": {
        await assertAdmin(supabase, userId);
        const txs = await supabase.from("transactions").select("*").eq("type", "withdrawal").eq("status", "pending").order("created_at", { ascending: false }).limit(200);
        if (txs.error) throw new Error(txs.error.message);
        const ids = [...new Set((txs.data ?? []).map((t: any) => t.user_id))];
        const profiles = ids.length ? await supabase.from("profiles").select("id, account_id, first_name, surname, email, phone, bank_name, bank_account_number").in("id", ids) : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({ data: { withdrawals: (txs.data ?? []).map((t: any) => ({ ...t, profiles: byId[t.user_id] ?? null })) } });
      }

      case "adminCompleteWithdrawal": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const completed = await supabase.rpc("admin_complete_withdrawal_secure", {
          p_tx_id: txId, p_note: typeof data.note === "string" ? data.note.slice(0, 300) : null,
        });
        if (completed.error) throw new Error(completed.error.message);
        return json({ data: { ok: true } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.type !== "withdrawal" || tx.data.status !== "pending") throw new Error("Withdrawal not found or already processed");
        const note = typeof data.note === "string" ? data.note.slice(0, 300) : "";
        const updated = await supabase.from("transactions").update({ status: "completed", description: `Withdrawal approved - Paid${note ? ` — ${note}` : ""}` }).eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        return json({ data: { ok: true } });
      }

      case "adminSeedDemo": {
        throw new Error("Demo seeding is disabled in production");

        /* Legacy flow retained below for historical source context; unreachable. */
        await assertAdmin(supabase, userId);
        const existing = await admin.from("profiles").select("id", { count: "exact", head: true }).like("email", "demo%@sparkleinsure.demo");
        if ((existing.count ?? 0) >= 5) return json({ data: { ok: true, seeded: 0 } });
        const demos = [["Thabo", "Mokoena", "+27821110002", "ZAR", 18450], ["Sarah", "Johnson", "+14155550104", "USD", 3120], ["Linda", "Naidoo", "+27831110005", "ZAR", 62400], ["Michael", "Van Wyk", "+27831110006", "ZAR", 9840], ["Emily", "Carter", "+14155550107", "USD", 1560]];
        let seeded = 0;
        for (let index = 0; index < demos.length; index += 1) { const [first, last, phone, currency, balance] = demos[index]; const email = `demo${index + 1}@sparkleinsure.demo`; const created = await admin.auth.admin.createUser({ email, password: `Demo!${crypto.randomUUID().slice(0, 8)}Aa1`, email_confirm: true, user_metadata: { first_name: first, surname: last, phone, primary_currency: currency } }); if (created.error || !created.data.user) { console.error(created.error); continue; } const id = created.data.user.id; await admin.from("profiles").update({ kyc_status: "verified" }).eq("id", id); await admin.from("wallets").update({ balance }).eq("user_id", id).eq("currency", currency); seeded += 1; }
        return json({ data: { ok: true, seeded } });
      }

      default:
        throw new Error("Unknown action");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error(message);
    return json({ error: message }, message === "Unauthorized" ? 401 : 400);
  }
});
