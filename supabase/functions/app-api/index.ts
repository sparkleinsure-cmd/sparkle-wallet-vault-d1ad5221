import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { readAllRows } from "./pagination.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const CURRENCIES = new Set(["ZAR", "USD"]);
const GROWTH_CYCLES = new Set(["15d", "30d", "180d", "360d"]);
const ADMIN_EMAIL = "sparkleinsure@gmail.com";
const PUBLIC_APP_ORIGIN = "https://sparkleinsure.app";
const RECRUITER_AGREEMENT_VERSION = "recruiter-v1-2026-09-03";

const SPARKLE_GENERAL_RESPONSE = `Firstly, thank you for reaching out to Sparkle Insure.

We help you fix small home appliances without the burden of monthly insurance fees.

Here’s how it works:

• No Monthly Fees: You only pay when you actually need a repair.
• Easy Claims: Send us the repair quotation for your appliance.
• Instant Coverage: Once approved, we pay the repair shop directly.
• Flexible Repayment: You repay the amount, plus a 40% fee, over 3 monthly instalments.

For Wallet Users (Earning Interest)

We connect short-term investor funds with active appliance repair claims.

• Lock & Earn: Lock funds for 15 days, 30 days, 6 months, or 12 months.
• Returns: Earn 30%–33%, depending on the selected lock period. Sparkle Insure charges a 3%–6% management fee.
• Capital Protection: Your wallet is insured. If a borrower defaults for more than 3 months, backup insurance covers the principal and pays a 10%–15% guaranteed yield.

Would you like to see the current insurance options or start with a small wallet deposit?`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
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

function requireGrowthCycle(value: unknown): "15d" | "30d" | "180d" | "360d" {
  if (typeof value !== "string" || !GROWTH_CYCLES.has(value))
    throw new Error("Select a valid growth cycle");
  return value as "15d" | "30d" | "180d" | "360d";
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

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordAdminFileView(admin: any, adminId: string, bucket: string, path: string) {
  const result = await admin.from("review_file_cleanup_queue").upsert(
    {
      bucket_id: bucket,
      object_path: path,
      viewed_at: new Date().toISOString(),
      viewed_by: adminId,
      last_error: null,
    },
    { onConflict: "bucket_id,object_path" },
  );
  if (result.error) throw new Error(result.error.message);
}

function supportMessage(row: any) {
  return {
    id: row.id,
    senderType: row.sender_type,
    body: row.body,
    aiModel: row.ai_model ?? null,
    createdAt: row.created_at,
  };
}

async function ensureSupportConversation(admin: any, memberId: string) {
  const existing = await admin
    .from("support_conversations")
    .select("*")
    .eq("user_id", memberId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return existing.data;
  const inserted = await admin
    .from("support_conversations")
    .insert({ user_id: memberId })
    .select("*")
    .maybeSingle();
  if (!inserted.error && inserted.data) return inserted.data;
  // A concurrent request may have created the member's single conversation.
  const concurrent = await admin
    .from("support_conversations")
    .select("*")
    .eq("user_id", memberId)
    .maybeSingle();
  if (concurrent.error || !concurrent.data)
    throw new Error(inserted.error?.message ?? "Unable to open support");
  return concurrent.data;
}

async function memberSupportThread(admin: any, memberId: string) {
  const conversation = await ensureSupportConversation(admin, memberId);
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // If the last message was more than 24 hours ago, clear messages and reset status
  if (conversation.last_message_at && conversation.last_message_at < cutoff24h) {
    await admin.from("support_messages").delete().eq("conversation_id", conversation.id);
    await admin
      .from("support_conversations")
      .update({
        status: "ai",
        assigned_admin_id: null,
        human_requested_at: null,
        unread_by_admin: 0,
        unread_by_user: 0,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);

    return {
      conversation: {
        id: conversation.id,
        status: "ai",
        humanRequestedAt: null,
        updatedAt: new Date().toISOString(),
      },
      messages: [],
    };
  }

  // Also clean up any individual messages older than 24h
  await admin
    .from("support_messages")
    .delete()
    .eq("conversation_id", conversation.id)
    .lt("created_at", cutoff24h);

  const messages = await admin
    .from("support_messages")
    .select("id,sender_type,body,ai_model,created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at")
    .limit(200);
  if (messages.error) throw new Error(messages.error.message);
  if (conversation.unread_by_user > 0) {
    await admin
      .from("support_conversations")
      .update({ unread_by_user: 0 })
      .eq("id", conversation.id);
  }
  return {
    conversation: {
      id: conversation.id,
      status: (messages.data?.length === 0 && conversation.status !== "ai") ? "ai" : conversation.status,
      humanRequestedAt: conversation.human_requested_at,
      updatedAt: conversation.updated_at,
    },
    messages: (messages.data ?? []).map(supportMessage),
  };
}

function mandyKnowledgeReply(message: string): string | null {
  const text = message
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
  if (/\b(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    return "Hi! I’m Mandy, Sparkle Insure’s automated support assistant. I can explain deposits, bank details, growth cycles, withdrawals, transfers, insurance, referrals, verification, and where to find things in the app. What would you like help with?";
  }
  if (/how (does|do|it)|how.*work|what is sparkle|tell me about sparkle/.test(text)) {
    return SPARKLE_GENERAL_RESPONSE;
  }

  if (/\b(thank you|thanks|bye|goodbye)\b/.test(text)) {
    return "You’re welcome. If you need anything else, send me another question or choose Talk to a human.";
  }

  if (
    /\b(my account number|user id|account id|payment reference|eft reference|deposit reference)\b/.test(
      text,
    )
  ) {
    return "Your Sparkle Account number is your User ID. You can see it in the app header and under Profile → Your details. Use that User ID as your EFT payment reference when depositing. This is different from Sparkle’s FNB deposit account number.";
  }

  if (
    /\b(my|mine)\b.*\b(balance|deposits?|withdrawals?|claims?|applications?|payments?|transfers?|bonuses?|verification|status|approved|declined|pending|missing|failed)\b/.test(
      text,
    )
  ) {
    return "I can explain Sparkle’s general rules, but I cannot inspect or decide private account activity. Please select Talk to a human so an administrator can check this securely.";
  }

  if (
    /\b(fnb|sparkle bank|deposit bank|banking details to deposit|where (do|can) i deposit|account (number|details) for deposit|branch code)\b/.test(
      text,
    )
  ) {
    return "To fund your Sparkle wallet, use FNB (First National Bank), account number 63224867101, branch code 250205. Use your Sparkle Account number (User ID) as the payment reference. Open Deposit in the app to copy these details and upload proof of payment.";
  }

  if (
    /\b(deposits?|eft|proof of payment|pop|fund (my|the) wallet|add (money|funds))\b/.test(text)
  ) {
    return "Open Deposit, choose a ZAR growth cycle and amount, make an immediate EFT using the banking details shown, then upload an image or PDF proof of payment (maximum 10 MB). The deposit stays pending and does not grow or become withdrawable until an administrator confirms the cleared funds. The selected cycle starts on approval.";
  }

  if (
    /\b(15 days?|30 days?|1 month|6 months?|12 months?|minimum|maximum|cycles?|cycle option|cycle amount|growth cycle|lock period)\b/.test(
      text,
    )
  ) {
    return "Sparkle’s ZAR growth cycles are: 15 Days (R100–R900), 1 Month / 30 days (R1,000–R9,000), 6 Months (R10,000–R19,000), and 12 Months (R20,000–R100,000). The Deposit and Move to growing screens show the expected withdrawable amount and estimated maturity date before you confirm.";
  }

  if (
    /\b(interest|return|earn|earning|management fee|capital protection|insured wallet|default|yield)\b/.test(
      text,
    )
  ) {
    return "Wallet users can earn through approved growth cycles that help fund active appliance-repair claims. The stated return is 30%–33% depending on the selected lock period, and Sparkle Insure charges a 3%–6% management fee. If a borrower defaults for more than 3 months, the stated backup cover protects the principal and provides a 10%–15% guaranteed yield. Review the exact expected amount shown in the app before confirming a cycle.";
  }

  if (/\b(move to growing|move funds|withdrawable to growing|start (a )?cycle)\b/.test(text)) {
    return "From the dashboard, select Move to growing, choose a cycle and enter an amount from your ZAR withdrawable balance. The app shows the maturity date and expected withdrawable amount before confirmation. This is a one-way move: the funds remain locked until that cycle matures.";
  }

  if (/\b(withdraw|withdrawals?|cash out|payouts?)\b/.test(text)) {
    return "Open Withdraw to request a payout from matured, withdrawable funds. Active growing funds cannot be withdrawn early. Payouts go only to the bank account saved under Profile, and the app states that an accepted withdrawal should reflect within 24 hours. For a specific pending or missing payout, please request a human.";
  }

  if (
    /\b(send funds|send money|transfer funds|transfer money|transfers?|another member|recipient)\b/.test(
      text,
    )
  ) {
    return "Use Send funds on the dashboard to transfer withdrawable funds to another Sparkle member using their User ID or registered phone number. Review the matched recipient before confirming. Active growing funds cannot be transferred. If a transfer requires administrator approval, no funds are deducted while it is pending.";
  }

  if (
    /\b(insurance (applications?|apply|eligibility|eligible|requirements?)|apply for (insurance|cover)|bank statements?|payslip|id copy)\b/.test(
      text,
    )
  ) {
    return "To apply for appliance insurance, your account must be more than 30 days old and have at least R1,000 in completed deposits during the last 30 days. Select at least one appliance and upload the latest 3 months of bank statements (PDF), your latest payslip (PDF), and an ID copy (image or PDF). Each file must be 10 MB or smaller. The stated review time is 5–7 business days.";
  }

  if (/\b(insurance|appliances?|repairs?|claims?|quotations?|cover)\b/.test(text)) {
    return "Sparkle Insure helps with small home-appliance repairs without a monthly insurance fee. After your cover is approved, select an insured item, enter the repair or replacement cost, and upload an image or PDF quotation. The claim cannot exceed your available insurance facility. After approval, Sparkle pays the repair shop directly. For a specific claim decision or delay, please request a human.";
  }

  if (/\b(repay|repayments?|40%|credit charge|instalments?|installments?)\b/.test(text)) {
    return "An approved appliance claim is repaid with a 40% credit charge over 3 repayments. Each repayment includes principal plus 13.33% of the claim, and repayments are automatically taken when withdrawable funds become available. Only one active repayment can be in progress before another claim is made.";
  }

  if (
    /\b(change bank|update bank|bank details|registered bank|saved bank|payout details)\b/.test(
      text,
    )
  ) {
    return "Go to Profile → Registered payout details to add your bank name and account number. Withdrawals are paid only to that saved account. After saving details, use Request to update banking details if a change is needed; the app will show when editing becomes available. Never send full bank details, passwords, or OTPs in support chat.";
  }

  if (/\b(selfie|face|verification|verify|kyc|welcome bonus|r10|camera)\b/.test(text)) {
    return "Under Profile → Welcome bonus, take a selfie or choose a photo. If a human face is detected, the selfie is approved automatically and an eligible R10 welcome bonus is credited; otherwise an administrator reviews it. The bonus is limited per device, so each account owner should use their own phone or browser. Account-specific eligibility questions need a human.";
  }

  if (/\b(friend|family|referral|refer|invite link|referral reward)\b/.test(text)) {
    return "The Friends & family referral pays a one-time 10% reward on the referred member’s first approved deposit, and the reward is immediately withdrawable. Copy or share your referral link from Referral options on the dashboard. The new member must sign up through that link before making a deposit.";
  }

  if (/\b(recruiter|salary|r3000|r3 000|qualification period|qualifying deposit)\b/.test(text)) {
    return "The Recruiter Programme offers a R3,000 qualifying salary plus the normal 10% first-deposit referral reward. Salary progress counts new members referred after recruiter approval; each first approved deposit must be at least R1,000 in the 30-day cycle, with R20,000 in combined qualifying deposits from the 29th through the 27th. If qualified, R3,000 is credited to the ZAR withdrawable wallet on the 28th.";
  }

  if (/\b(statements?|transactions?|recent activity|history|receipts?)\b/.test(text)) {
    return "Open Statement in the bottom navigation to review your transaction history. Recent activity also appears on the dashboard. A plus sign means money was credited; a minus sign means money was debited. For an unfamiliar or incorrect transaction, request a human support agent.";
  }

  if (
    /\b(portfolio|total balance|withdrawable|growing|locked|maturity|matured funds)\b/.test(text)
  ) {
    return "Portfolio is your total wallet value. Withdrawable is matured money available to send or withdraw. Current (Growing) is money locked in active cycles. Open View Active Cycles on the dashboard to see each cycle’s amount and maturity date. When a cycle matures, its proceeds move to withdrawable.";
  }

  if (
    /\b(profile|phone number|address|personal details|sign out|log out|delete account|dark mode|theme)\b/.test(
      text,
    )
  ) {
    return "Open Profile from the bottom navigation to manage contact details, theme, payout details, verification, WhatsApp support, sign out, or account deletion. Account deletion is permanent and requires typing DELETE to confirm.";
  }

  if (/\b(whatsapp|contact|phone|support|human|admin|administrator|person|agent)\b/.test(text)) {
    return "You can request a human in this conversation by selecting Talk to a human or typing that you want an administrator. WhatsApp Support remains available under Profile.";
  }

  if (/\b(my|mine)\b.*\b(account|frozen|freeze)\b/.test(text)) {
    return "I can explain Sparkle’s general rules, but I cannot inspect or decide private account activity. Please select Talk to a human so an administrator can check this securely.";
  }

  return null;
}

function generateMandyReply(message: string) {
  return {
    body:
      mandyKnowledgeReply(message) ??
      "I don’t have a verified Sparkle answer for that question. Please select Talk to a human and an administrator will continue this conversation.",
    model: "mandy-faq-v2",
  };
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
    if (!supabaseUrl || !anonKey || !serviceRoleKey)
      throw new Error("Supabase function secrets are not configured");

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) throw new Error("Unauthorized");
    const userId = auth.user.id;
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action : "";
    const data = body?.data ?? {};

    if (
      !action.startsWith("admin") &&
      ![
        "getMe",
        "recordPresence",
        "submitAccountFreezeDispute",
        "deleteMyAccount",
        "getSupportConversation",
        "sendSupportMessage",
        "requestSupportHuman",
      ].includes(action)
    ) {
      const freeze = await admin
        .from("profiles")
        .select("account_frozen")
        .eq("id", userId)
        .maybeSingle();
      if (freeze.error) throw new Error(freeze.error.message);
      if (freeze.data?.account_frozen) {
        throw new Error("Your account is frozen while a compliance review is in progress");
      }
    }

    switch (action) {
      case "getMe": {
        const installationId =
          typeof data.installationId === "string" && /^[0-9a-f-]{36}$/i.test(data.installationId)
            ? data.installationId
            : null;
        const currentInstallationHash = installationId ? await sha256(installationId) : null;
        const maturity = await admin.rpc("settle_due_tranches_for_user", { p_user_id: userId });
        if (maturity.error) throw new Error(maturity.error.message);
        const acceptedInvite = await admin
          .from("recruiter_invites")
          .update({ status: "accepted", accepted_at: new Date().toISOString() })
          .eq("invited_user_id", userId)
          .eq("status", "sent");
        if (acceptedInvite.error)
          console.error("Could not mark recruiter invite accepted", acceptedInvite.error.message);
        const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
        const clientIp = req.headers.get("cf-connecting-ip") ?? forwardedFor;
        if (clientIp) {
          // Key the hash so retained network signals cannot be reversed by
          // enumerating the relatively small IPv4 address space.
          const networkHash = await sha256(`${serviceRoleKey}:network:${clientIp}`);
          const remembered = await admin.rpc("remember_signup_signal_hash", {
            p_user_id: userId,
            p_signal_type: "network",
            p_signal_hash: networkHash,
          });
          if (remembered.error)
            console.error("Could not remember network signup signal", remembered.error.message);
        }
        const [profileRes, walletsRes, txRes, rolesRes, tranchesRes, disputesRes] =
          await Promise.all([
            supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
            supabase.from("wallets").select("*").eq("user_id", userId).order("currency"),
            supabase
              .from("transactions")
              .select("*")
              .eq("user_id", userId)
              .order("created_at", { ascending: false })
              .limit(200),
            supabase.from("user_roles").select("role").eq("user_id", userId),
            supabase
              .from("deposit_tranches")
              .select("*")
              .eq("user_id", userId)
              .gt("remaining", 0)
              .order("created_at"),
            supabase
              .from("account_freeze_disputes")
              .select("*")
              .eq("user_id", userId)
              .order("created_at", { ascending: false })
              .limit(10),
          ]);
        if (profileRes.error) throw new Error(profileRes.error.message);
        let welcomeBonusClaimedAt = profileRes.data?.welcome_bonus_credited_at ?? null;
        let welcomeBonusEligible = true;
        const signals = await admin
          .from("signup_risk_signals")
          .select("signal_type,signal_hash")
          .eq("user_id", userId);
        if (signals.error) throw new Error(signals.error.message);
        const hashes = [...new Set((signals.data ?? []).map((signal: any) => signal.signal_hash))];
        const exemptionCandidates = [
          ...new Set([
            ...(signals.data ?? [])
              .filter((signal: any) => signal.signal_type === "installation")
              .map((signal: any) => signal.signal_hash),
            ...(currentInstallationHash ? [currentInstallationHash] : []),
          ]),
        ];
        const exemptions = exemptionCandidates.length
          ? await admin
              .from("bonus_test_installations")
              .select("signal_hash")
              .in("signal_hash", exemptionCandidates)
          : { data: [], error: null };
        if (exemptions.error) throw new Error(exemptions.error.message);
        const exemptInstallationHashes = new Set(
          (exemptions.data ?? []).map((entry: any) => entry.signal_hash),
        );
        if (hashes.length) {
          const history = await admin
            .from("signup_identity_history")
            .select("signal_type,signal_hash,first_user_id,bonus_claimed_at")
            .in("signal_hash", hashes);
          if (history.error) throw new Error(history.error.message);
          const currentSignals = new Set(
            (signals.data ?? []).map(
              (signal: any) => `${signal.signal_type}:${signal.signal_hash}`,
            ),
          );
          const matchingHistory = (history.data ?? []).filter((entry: any) =>
            currentSignals.has(`${entry.signal_type}:${entry.signal_hash}`),
          );
          // Network addresses and broad browser/system fingerprints can be
          // shared by unrelated people. They are useful for risk analysis,
          // but must never make a new member appear to have claimed a bonus.
          const strongMatchingHistory = matchingHistory.filter(
            (entry: any) =>
              ["email", "phone"].includes(entry.signal_type) ||
              (entry.signal_type === "installation" &&
                !exemptInstallationHashes.has(entry.signal_hash)),
          );
          if (!welcomeBonusClaimedAt) {
            welcomeBonusClaimedAt =
              strongMatchingHistory
                .map((entry: any) => entry.bonus_claimed_at)
                .filter(Boolean)
                .sort()[0] ?? null;
          }
          welcomeBonusEligible = !strongMatchingHistory.some(
            (entry: any) => entry.first_user_id !== userId,
          );
        }
        const profile = profileRes.data
          ? {
              ...profileRes.data,
              welcome_bonus_claimed_at: welcomeBonusClaimedAt,
              welcome_bonus_eligible: welcomeBonusEligible,
              welcome_bonus_test_device: Boolean(
                currentInstallationHash && exemptInstallationHashes.has(currentInstallationHash),
              ),
            }
          : null;
        return json({
          data: {
            profile,
            wallets: walletsRes.data ?? [],
            transactions: txRes.data ?? [],
            roles: (rolesRes.data ?? []).map((r: any) => r.role),
            tranches: tranchesRes.data ?? [],
            accountFreezeDisputes: disputesRes.data ?? [],
          },
        });
      }

      case "getRecruiterDashboard": {
        const result = await supabase.rpc("get_my_recruiter_dashboard");
        if (result.error) throw new Error(result.error.message);
        return json({ data: result.data });
      }

      case "submitRecruiterApplication": {
        const declarationAccepted = data.declarationAccepted === true;
        const result = await supabase.rpc("submit_my_recruiter_application", {
          p_agreement_version: RECRUITER_AGREEMENT_VERSION,
          p_declaration_accepted: declarationAccepted,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true, approved: true, applicationId: result.data } });
      }

      case "recruiterInviteMember": {
        if (data.consentAttested !== true) {
          throw new Error("Confirm that the person consented to receive this account invitation");
        }
        const recruiter = await admin
          .from("recruiter_applications")
          .select("id,status")
          .eq("user_id", userId)
          .eq("status", "approved")
          .maybeSingle();
        if (recruiter.error) throw new Error(recruiter.error.message);
        if (!recruiter.data) throw new Error("An approved recruiter account is required");

        const firstName = requireString(data.firstName, "first name", 1, 100);
        const surname = requireString(data.surname, "surname", 1, 100);
        const email = requireString(data.email, "email", 3, 320).toLowerCase();
        const phone = requireString(data.phone, "phone number", 8, 30);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new Error("Enter a valid email address");
        const phoneDigits = phone.replace(/\D/g, "");
        if (phoneDigits.length < 8 || phoneDigits.length > 15)
          throw new Error("Enter a valid phone number");

        const since = new Date(Date.now() - 86_400_000).toISOString();
        const inviteCount = await admin
          .from("recruiter_invites")
          .select("id", { count: "exact", head: true })
          .eq("recruiter_id", userId)
          .gte("created_at", since);
        if (inviteCount.error) throw new Error(inviteCount.error.message);
        if ((inviteCount.count ?? 0) >= 25)
          throw new Error("Daily invitation limit reached. Try again tomorrow");

        const availability = await admin.rpc("check_signup_availability", {
          p_email: email,
          p_phone: phone,
        });
        if (availability.error) throw new Error(availability.error.message);
        if (availability.data?.emailExists)
          throw new Error("An account with this email already exists");
        if (availability.data?.phoneExists)
          throw new Error("An account with this phone number already exists");

        const recruiterProfile = await admin
          .from("profiles")
          .select("account_id")
          .eq("id", userId)
          .single();
        if (recruiterProfile.error) throw new Error(recruiterProfile.error.message);

        const queued = await admin
          .from("recruiter_invites")
          .insert({
            recruiter_id: userId,
            invitee_email: email,
            invitee_first_name: firstName,
            invitee_surname: surname,
            invitee_phone: phone,
            consent_attested_at: new Date().toISOString(),
            status: "pending",
          })
          .select("id")
          .single();
        if (queued.error) {
          if (/unique|duplicate/i.test(queued.error.message))
            throw new Error("This email address has already been invited");
          throw new Error(queued.error.message);
        }

        const invited = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${PUBLIC_APP_ORIGIN}/auth/callback?next=reset`,
          data: {
            first_name: firstName,
            surname,
            phone,
            primary_currency: "ZAR",
            referral_code: recruiterProfile.data.account_id,
            recruiter_invite_id: queued.data.id,
          },
        });
        if (invited.error || !invited.data.user) {
          await admin
            .from("recruiter_invites")
            .update({
              status: "failed",
              provider_error: (invited.error?.message ?? "Invitation failed").slice(0, 500),
            })
            .eq("id", queued.data.id);
          throw new Error(invited.error?.message ?? "The invitation could not be sent");
        }

        const sent = await admin
          .from("recruiter_invites")
          .update({
            invited_user_id: invited.data.user.id,
            status: "sent",
            sent_at: new Date().toISOString(),
            provider_error: null,
          })
          .eq("id", queued.data.id);
        if (sent.error) throw new Error(sent.error.message);
        return json({ data: { ok: true, inviteId: queued.data.id } });
      }

      case "recordPresence": {
        const result = await admin
          .from("user_presence")
          .upsert(
            { user_id: userId, last_seen_at: new Date().toISOString() },
            { onConflict: "user_id" },
          );
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "submitAccountFreezeDispute": {
        const documentPath = requireString(data.documentPath, "PDF document", 3, 500);
        const statement = requireString(data.statement, "written statement", 10, 2000);
        const result = await supabase.rpc("submit_account_freeze_dispute", {
          p_document_path: documentPath,
          p_statement: statement,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true, disputeId: result.data } });
      }

      case "getInsuranceDashboard": {
        const applications = await supabase
          .from("insurance_applications")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10);
        const claims = await supabase
          .from("insurance_claims")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50);
        const eligibility = await supabase.rpc("insurance_eligibility", { p_user_id: userId });
        if (applications.error) throw new Error(applications.error.message);
        if (claims.error) throw new Error(claims.error.message);
        if (eligibility.error) throw new Error(eligibility.error.message);
        return json({
          data: {
            application: applications.data?.[0] ?? null,
            applications: applications.data ?? [],
            claims: claims.data ?? [],
            eligibility: eligibility.data,
          },
        });
      }

      case "submitInsuranceApplication": {
        const items = Array.isArray(data.items)
          ? data.items.map((x: unknown) => requireString(x, "item", 2, 80))
          : [];
        const bankPaths = Array.isArray(data.bankStatementPaths)
          ? data.bankStatementPaths.map((x: unknown) => requireString(x, "bank statement", 3, 500))
          : [];
        const payslipPath = requireString(data.payslipPath, "payslip", 3, 500);
        const idCopyPath = requireString(data.idCopyPath, "ID copy", 3, 500);
        const result = await supabase.rpc("submit_insurance_application", {
          p_items: items,
          p_bank_paths: bankPaths,
          p_payslip_path: payslipPath,
          p_id_copy_path: idCopyPath,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true, applicationId: result.data } });
      }

      case "submitInsuranceClaim": {
        const item = requireString(data.item, "item", 2, 80);
        const amount = requireAmount(data.amount, 1_000_000);
        const quotationPath = requireString(data.quotationPath, "quotation", 3, 500);
        const result = await supabase.rpc("submit_insurance_claim", {
          p_item: item,
          p_amount: amount,
          p_quotation_path: quotationPath,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true, claimId: result.data } });
      }

      case "getAccountHealth": {
        const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
        const [snapshots, rewards] = await Promise.all([
          supabase
            .from("wallet_health_daily")
            .select(
              "snapshot_date, wallet_value_zar, withdrawable_zar, wallet_health, daily_top_ups, withdrawals, penalties, reward_credit",
            )
            .eq("user_id", userId)
            .gte("snapshot_date", since)
            .order("snapshot_date"),
          supabase
            .from("wallet_reward_credits")
            .select("points, value, qualifying_date")
            .eq("user_id", userId)
            .order("qualifying_date", { ascending: false })
            .limit(20),
        ]);
        if (snapshots.error) throw new Error(snapshots.error.message);
        if (rewards.error) throw new Error(rewards.error.message);
        const profile = await supabase
          .from("profiles")
          .select("reward_points, reward_streak_days")
          .eq("id", userId)
          .maybeSingle();
        if (profile.error) throw new Error(profile.error.message);
        return json({
          data: {
            snapshots: snapshots.data ?? [],
            rewards: rewards.data ?? [],
            points: profile.data?.reward_points ?? 0,
            streakDays: profile.data?.reward_streak_days ?? 0,
          },
        });
      }

      case "getStatementTransactions": {
        const days = Number(data.days);
        if (![7, 30, 90].includes(days)) throw new Error("Invalid statement period");
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const transactions: unknown[] = [];
        for (let from = 0; ; from += 1_000) {
          const { data: page, error } = await supabase
            .from("transactions")
            .select("id, type, currency, amount, status, description, created_at")
            .eq("user_id", userId)
            .gte("created_at", cutoff)
            .order("created_at", { ascending: false })
            .range(from, from + 999);
          if (error) throw new Error(error.message);
          transactions.push(...(page ?? []));
          if (!page || page.length < 1_000) break;
        }
        return json({ data: transactions });
      }

      case "setPrimaryCurrency": {
        const currency = requireCurrency(data.currency);
        const { error } = await supabase.rpc("set_primary_currency_secure", {
          p_currency: currency,
        });
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
          p_phone: phone,
          p_street_address: streetAddress,
          p_province: province,
          p_postal_code: postalCode,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "creditDeposit": {
        const amount = requireAmount(data.amount);
        const currency = requireCurrency(data.currency);
        if (currency !== "ZAR") throw new Error("Growth cycles support ZAR only");
        const cycleCode = requireGrowthCycle(data.cycleCode);
        const reference = requireString(data.reference, "reference", 3, 200);
        const proofUrl = requireString(data.proofUrl, "proof", 3, 500);
        const secureDeposit = await supabase.rpc("submit_deposit_secure", {
          p_amount: amount,
          p_currency: currency,
          p_reference: reference,
          p_proof_path: proofUrl,
          p_cycle_code: cycleCode,
        });
        if (secureDeposit.error) throw new Error(secureDeposit.error.message);
        return json({ data: { ok: true, transactionId: secureDeposit.data, status: "pending" } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const existing = await supabase
          .from("transactions")
          .select("id")
          .eq("reference", reference)
          .eq("user_id", userId)
          .maybeSingle();
        if (existing.data) return json({ data: { ok: true, deduped: true } });
        const wallet = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", userId)
          .eq("currency", currency)
          .maybeSingle();
        if (wallet.error) throw new Error(wallet.error.message);
        const next = Number(wallet.data?.balance ?? 0) + amount;
        const walletUpdate = await supabase
          .from("wallets")
          .update({ balance: next, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("currency", currency);
        if (walletUpdate.error) throw new Error(walletUpdate.error.message);
        const tx = await supabase
          .from("transactions")
          .insert({
            user_id: userId,
            type: "deposit",
            currency,
            amount,
            status: "pending",
            reference,
            description: "Bank deposit — awaiting admin verification",
            proof_url: proofUrl,
          })
          .select("id")
          .maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        const tranche = await supabase.from("deposit_tranches").insert({
          user_id: userId,
          currency,
          amount,
          remaining: amount,
          current_balance: amount,
          status: "locked",
          source: "deposit",
          transaction_id: tx.data?.id ?? null,
          maturity_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          approved: false,
        });
        if (tranche.error) throw new Error(tranche.error.message);
        return json({ data: { ok: true, balance: next } });
      }

      case "requestWithdrawal": {
        const amount = requireAmount(data.amount);
        const currency = requireCurrency(data.currency);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const secureWithdrawal = await supabase.rpc("request_withdrawal_idempotent_secure", {
          p_amount: amount,
          p_currency: currency,
          p_request_id: requestId,
        });
        if (secureWithdrawal.error) throw new Error(secureWithdrawal.error.message);
        return json({ data: { ok: true, ...(secureWithdrawal.data ?? {}) } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const profile = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
        if (!profile.data) throw new Error("Profile not found");
        const wallet = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", userId)
          .eq("currency", currency)
          .maybeSingle();
        const current = Number(wallet.data?.balance ?? 0);
        if (current < amount) throw new Error("Insufficient balance");
        const tranchesRes = await supabase
          .from("deposit_tranches")
          .select("*")
          .eq("user_id", userId)
          .eq("currency", currency)
          .gt("remaining", 0)
          .order("created_at");
        if (tranchesRes.error) throw new Error(tranchesRes.error.message);
        const now = Date.now();
        const matured = (tranchesRes.data ?? []).filter(
          (t: any) => new Date(t.maturity_date).getTime() <= now,
        );
        const locked = (tranchesRes.data ?? []).filter(
          (t: any) => new Date(t.maturity_date).getTime() > now,
        );
        const withdrawable =
          current - locked.reduce((sum: number, t: any) => sum + Number(t.remaining), 0);
        if (amount > withdrawable && !data.confirmBreak) throw new Error("BREAKS_TRANCHE");
        let remaining = amount;
        const consume = async (tranche: any, take: number) => {
          const principal = Number(tranche.remaining);
          const value = Number(tranche.current_balance ?? tranche.remaining);
          const principalTake = Math.min(
            principal,
            Math.round(principal * (value > 0 ? take / value : 1) * 100) / 100,
          );
          const nextRemaining = Math.max(0, principal - principalTake);
          const nextValue = Math.max(0, value - take);
          const { error } = await supabase
            .from("deposit_tranches")
            .update({
              remaining: nextRemaining,
              current_balance: nextValue,
              ...(nextValue === 0 ? { status: "liquidated" } : {}),
            })
            .eq("id", tranche.id);
          if (error) throw new Error(error.message);
        };
        for (const tranche of matured) {
          if (remaining <= 0) break;
          const take = Math.min(Number(tranche.current_balance ?? tranche.remaining), remaining);
          if (take > 0) {
            await consume(tranche, take);
            remaining -= take;
          }
        }
        if (amount <= withdrawable) remaining = 0;
        if (remaining > 0 && data.confirmBreak)
          for (const tranche of locked) {
            if (remaining <= 0) break;
            const take = Math.min(Number(tranche.current_balance ?? tranche.remaining), remaining);
            if (take > 0) {
              await consume(tranche, take);
              remaining -= take;
            }
          }
        if (remaining > 0) throw new Error("Unable to withdraw requested amount");
        const growingAmount = Math.max(0, amount - withdrawable);
        const penalty = Math.round(growingAmount * 0.05 * 100) / 100;
        const payoutAmount = Math.round((amount - penalty) * 100) / 100;
        const bankName = typeof data.bankName === "string" ? data.bankName.slice(0, 200) : "n/a";
        const accountNumber =
          typeof data.accountNumber === "string" ? data.accountNumber.slice(0, 100) : "n/a";
        const tx = await supabase
          .from("transactions")
          .insert({
            user_id: userId,
            type: "withdrawal",
            currency,
            amount: payoutAmount,
            status: "pending",
            description: `Withdrawal request — Bank: ${bankName} · Acc: ${accountNumber}`,
          })
          .select("id")
          .maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        if (penalty > 0) {
          const fee = await supabase.from("transactions").insert({
            user_id: userId,
            type: "fee",
            currency,
            amount: penalty,
            status: "completed",
            description: `Early withdrawal penalty (5%) on ${currency} ${growingAmount.toFixed(2)}. Included in the gross withdrawal amount.`,
            reference: tx.data?.id ?? null,
          });
          if (fee.error) throw new Error(fee.error.message);
        }
        const walletUpdate = await supabase
          .from("wallets")
          .update({ balance: current - amount, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("currency", currency);
        if (walletUpdate.error) throw new Error(walletUpdate.error.message);
        const p = profile.data;
        await sendEmail(
          ADMIN_EMAIL,
          `Withdrawal request — ${p.account_id}`,
          `New withdrawal request\n\nUser ID: ${p.account_id}\nName: ${p.first_name} ${p.surname}\nEmail: ${p.email}\nPhone: ${p.phone}\nGross withdrawal: ${currency} ${amount.toFixed(2)}\nEarly withdrawal penalty: ${currency} ${penalty.toFixed(2)}\nNet bank payout: ${currency} ${payoutAmount.toFixed(2)}\nBank: ${bankName}\nAccount: ${accountNumber}`,
        );
        return json({ data: { ok: true, grossAmount: amount, penalty, payoutAmount } });
      }

      case "moveWithdrawableToGrowing": {
        const amount = requireAmount(data.amount);
        const currency = requireCurrency(data.currency);
        if (currency !== "ZAR") throw new Error("Growth cycles support ZAR only");
        const cycleCode = requireGrowthCycle(data.cycleCode);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const moved = await supabase.rpc("move_withdrawable_to_growing_idempotent_secure", {
          p_amount: amount,
          p_currency: currency,
          p_request_id: requestId,
          p_cycle_code: cycleCode,
        });
        if (moved.error) throw new Error(moved.error.message);
        return json({ data: moved.data });
      }

      case "resolveTransferRecipient": {
        const recipient = requireString(data.recipient, "recipient", 3, 50);
        const resolved = await supabase.rpc("resolve_member_transfer_recipient_secure", {
          p_recipient: recipient,
        });
        if (resolved.error) throw new Error(resolved.error.message);
        return json({ data: resolved.data });
      }

      case "sendFunds": {
        const recipient = requireString(data.recipient, "recipient", 3, 50);
        const currency = requireCurrency(data.currency);
        const amount = requireAmount(data.amount);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const sent = await supabase.rpc("send_member_withdrawable_funds_secure", {
          p_recipient: recipient,
          p_currency: currency,
          p_amount: amount,
          p_request_id: requestId,
        });
        if (sent.error) throw new Error(sent.error.message);
        return json({ data: sent.data });
      }

      case "adminListPendingMemberTransfers": {
        await assertAdmin(supabase, userId);
        const pending = await supabase.rpc("admin_list_pending_member_transfers");
        if (pending.error) throw new Error(pending.error.message);
        return json({ data: pending.data });
      }

      case "adminReviewMemberTransfer": {
        await assertAdmin(supabase, userId);
        const transferId = requireString(data.transferId, "transfer", 36, 36);
        const decision =
          data.decision === "approved" || data.decision === "declined"
            ? data.decision
            : (() => {
                throw new Error("Invalid transfer decision");
              })();
        const note = typeof data.note === "string" ? data.note.trim().slice(0, 300) : null;
        const reviewed = await supabase.rpc("admin_review_member_transfer_secure", {
          p_transfer_id: transferId,
          p_decision: decision,
          p_note: note || null,
        });
        if (reviewed.error) throw new Error(reviewed.error.message);
        return json({ data: reviewed.data });
      }

      case "adminClearOwnGrowingBalance": {
        await assertAdmin(supabase, userId);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const cleared = await supabase.rpc("admin_clear_own_growing_balance_secure", {
          p_request_id: requestId,
        });
        if (cleared.error) throw new Error(cleared.error.message);
        return json({ data: cleared.data });
      }

      case "submitKycReview": {
        const selfiePath = requireString(data.selfiePath, "selfie", 3, 500);
        const faceDetected = data.faceDetected === true;
        const faceConfidence =
          faceDetected && Number.isFinite(Number(data.faceConfidence))
            ? Number(data.faceConfidence)
            : null;
        const detectorVersion =
          data.detectorVersion === "mediapipe-blazeface-short-range-v1"
            ? data.detectorVersion
            : "unavailable";
        const result = await supabase.rpc("submit_kyc_review_auto", {
          p_selfie_path: selfiePath,
          p_face_detected: faceDetected,
          p_face_confidence: faceConfidence,
          p_detector_version: detectorVersion,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: result.data });
      }

      case "getSupportConversation": {
        return json({ data: await memberSupportThread(admin, userId) });
      }

      case "sendSupportMessage": {
        const message = requireString(data.message, "support message", 1, 2000);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid request ID");
        let conversation = await ensureSupportConversation(admin, userId);
        const replay = await admin
          .from("support_messages")
          .select("id")
          .eq("conversation_id", conversation.id)
          .eq("client_request_id", requestId)
          .maybeSingle();
        if (replay.error) throw new Error(replay.error.message);
        if (replay.data) return json({ data: await memberSupportThread(admin, userId) });

        const recentMessages = await admin
          .from("support_messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", conversation.id)
          .eq("sender_type", "user")
          .gte("created_at", new Date(Date.now() - 60_000).toISOString());
        if (recentMessages.error) throw new Error(recentMessages.error.message);
        if ((recentMessages.count ?? 0) >= 10) {
          throw new Error("Please wait a minute before sending more support messages");
        }

        if (conversation.status === "closed") {
          const reopened = await admin
            .from("support_conversations")
            .update({
              status: "ai",
              assigned_admin_id: null,
              human_requested_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversation.id)
            .select("*")
            .maybeSingle();
          if (reopened.error || !reopened.data)
            throw new Error(reopened.error?.message ?? "Unable to reopen support");
          conversation = reopened.data;
        }

        const inserted = await admin
          .from("support_messages")
          .insert({
            conversation_id: conversation.id,
            sender_type: "user",
            sender_user_id: userId,
            body: message,
            client_request_id: requestId,
          })
          .select("id")
          .maybeSingle();
        if (inserted.error?.code === "23505") {
          return json({ data: await memberSupportThread(admin, userId) });
        }
        if (inserted.error || !inserted.data)
          throw new Error(inserted.error?.message ?? "Unable to send message");

        const asksForHuman =
          /(^\s*(human|administrator|admin|person|consultant|support agent|real agent)(\s+please)?[.!]?\s*$)|\b(talk|speak|chat|transfer|connect|contact|need|want|request|get)\b.{0,30}\b(human|administrator|admin|person|consultant|support agent|real agent)\b/i.test(
            message,
          );
        if (asksForHuman && conversation.status === "ai") {
          const now = new Date().toISOString();
          await admin
            .from("support_conversations")
            .update({
              status: "waiting_for_admin",
              human_requested_at: now,
              unread_by_admin: Number(conversation.unread_by_admin ?? 0) + 1,
              last_message_at: now,
              updated_at: now,
            })
            .eq("id", conversation.id);
          await admin.from("support_messages").insert({
            conversation_id: conversation.id,
            sender_type: "system",
            body: "Human support requested. An administrator will respond in this conversation.",
            reply_to_message_id: inserted.data.id,
          });
          return json({ data: await memberSupportThread(admin, userId) });
        }

        if (conversation.status === "ai") {
          const reply = generateMandyReply(message);
          const botMessage = await admin.from("support_messages").insert({
            conversation_id: conversation.id,
            sender_type: "mandy",
            body: reply.body,
            ai_model: reply.model,
            reply_to_message_id: inserted.data.id,
          });
          if (botMessage.error && botMessage.error.code !== "23505")
            throw new Error(botMessage.error.message);
          const now = new Date().toISOString();
          await admin
            .from("support_conversations")
            .update({ last_message_at: now, updated_at: now })
            .eq("id", conversation.id);
        } else {
          const now = new Date().toISOString();
          await admin
            .from("support_conversations")
            .update({
              unread_by_admin: Number(conversation.unread_by_admin ?? 0) + 1,
              last_message_at: now,
              updated_at: now,
            })
            .eq("id", conversation.id);
        }
        return json({ data: await memberSupportThread(admin, userId) });
      }

      case "requestSupportHuman": {
        const conversation = await ensureSupportConversation(admin, userId);
        if (conversation.status !== "waiting_for_admin" && conversation.status !== "admin_active") {
          const now = new Date().toISOString();
          const updated = await admin
            .from("support_conversations")
            .update({
              status: "waiting_for_admin",
              assigned_admin_id: null,
              human_requested_at: now,
              unread_by_admin: Number(conversation.unread_by_admin ?? 0) + 1,
              last_message_at: now,
              updated_at: now,
            })
            .eq("id", conversation.id);
          if (updated.error) throw new Error(updated.error.message);
          const systemMessage = await admin.from("support_messages").insert({
            conversation_id: conversation.id,
            sender_type: "system",
            body: "Human support requested. An administrator will respond in this conversation.",
          });
          if (systemMessage.error) throw new Error(systemMessage.error.message);
        }
        return json({ data: await memberSupportThread(admin, userId) });
      }

      case "deleteMyAccount": {
        // Remove private files first; deleting the auth user then cascades the
        // profile, wallet, transaction, tranche, and role records.
        for (const bucket of ["kyc", "deposits", "insurance", "community", "account-disputes"]) {
          const listed = await admin.storage.from(bucket).list(userId, { limit: 1000 });
          if (!listed.error && listed.data?.length) {
            await admin.storage
              .from(bucket)
              .remove(listed.data.map((file) => `${userId}/${file.name}`));
          }
        }
        // Reviewer references intentionally do not cascade because historical
        // decisions remain visible. Detach them before an administrator deletes
        // their own account so the Auth deletion cannot be blocked.
        await admin
          .from("insurance_claims")
          .update({ reviewed_by: null })
          .eq("reviewed_by", userId);
        await admin
          .from("insurance_applications")
          .update({ reviewed_by: null })
          .eq("reviewed_by", userId);
        // Hard-delete the Auth identity. Passing `true` here soft-deletes the
        // user and keeps the email reserved, preventing a clean re-registration.
        const deleted = await admin.auth.admin.deleteUser(userId);
        if (deleted.error) throw new Error(deleted.error.message);
        return json({ data: { ok: true } });
      }

      case "adminSetKycStatus": {
        await assertAdmin(supabase, userId);
        const targetUserId = requireString(data.userId, "user", 36, 36);
        const status =
          data.status === "verified" ? "verified" : data.status === "rejected" ? "rejected" : null;
        if (!status) throw new Error("Invalid status");
        const { error } = await supabase.rpc("admin_set_kyc_status", {
          p_user_id: targetUserId,
          p_status: status,
        });
        if (error) throw new Error(error.message);
        return json({ data: { ok: true } });
      }

      case "adminListPendingKyc": {
        await assertAdmin(supabase, userId);
        const reviews = await supabase
          .from("profiles")
          .select(
            "id, account_id, first_name, surname, email, phone, proof_url, selfie_url, created_at",
          )
          .eq("kyc_status", "pending")
          .not("selfie_url", "is", null)
          .order("created_at", { ascending: false })
          .limit(100);
        if (reviews.error) throw new Error(reviews.error.message);
        return json({ data: { reviews: reviews.data ?? [] } });
      }

      case "adminListSupportConversations": {
        await assertAdmin(supabase, userId);
        const conversations = await admin
          .from("support_conversations")
          .select("*")
          .order("last_message_at", { ascending: false })
          .limit(200);
        if (conversations.error) throw new Error(conversations.error.message);
        const memberIds = (conversations.data ?? []).map(
          (conversation: any) => conversation.user_id,
        );
        const [profiles, recentMessages] = memberIds.length
          ? await Promise.all([
              admin
                .from("profiles")
                .select("id,account_id,first_name,surname,email")
                .in("id", memberIds),
              admin
                .from("support_messages")
                .select("conversation_id,sender_type,body,created_at")
                .in(
                  "conversation_id",
                  (conversations.data ?? []).map((conversation: any) => conversation.id),
                )
                .order("created_at", { ascending: false })
                .limit(1000),
            ])
          : [
              { data: [], error: null },
              { data: [], error: null },
            ];
        if (profiles.error) throw new Error(profiles.error.message);
        if (recentMessages.error) throw new Error(recentMessages.error.message);
        const profileById = Object.fromEntries(
          (profiles.data ?? []).map((profile: any) => [profile.id, profile]),
        );
        const latestByConversation: Record<string, any> = {};
        for (const message of recentMessages.data ?? []) {
          if (!latestByConversation[message.conversation_id])
            latestByConversation[message.conversation_id] = message;
        }
        return json({
          data: {
            conversations: (conversations.data ?? []).map((conversation: any) => {
              const profile = profileById[conversation.user_id];
              const latest = latestByConversation[conversation.id];
              return {
                id: conversation.id,
                userId: conversation.user_id,
                status: conversation.status,
                unreadByAdmin: Number(conversation.unread_by_admin ?? 0),
                humanRequestedAt: conversation.human_requested_at,
                lastMessageAt: conversation.last_message_at,
                memberName:
                  [profile?.first_name, profile?.surname].filter(Boolean).join(" ") ||
                  "Unknown member",
                accountId: profile?.account_id ?? "Unknown",
                email: profile?.email ?? null,
                latestMessage: latest
                  ? {
                      senderType: latest.sender_type,
                      body: latest.body,
                      createdAt: latest.created_at,
                    }
                  : null,
              };
            }),
          },
        });
      }

      case "adminGetSupportConversation": {
        await assertAdmin(supabase, userId);
        const conversationId = requireString(data.conversationId, "conversation", 36, 36);
        const conversation = await admin
          .from("support_conversations")
          .select("*")
          .eq("id", conversationId)
          .maybeSingle();
        if (conversation.error) throw new Error(conversation.error.message);
        if (!conversation.data) throw new Error("Support conversation not found");
        const [messages, profile] = await Promise.all([
          admin
            .from("support_messages")
            .select("id,sender_type,body,ai_model,created_at")
            .eq("conversation_id", conversationId)
            .order("created_at")
            .limit(300),
          admin
            .from("profiles")
            .select("id,account_id,first_name,surname,email,phone")
            .eq("id", conversation.data.user_id)
            .maybeSingle(),
        ]);
        if (messages.error) throw new Error(messages.error.message);
        if (profile.error) throw new Error(profile.error.message);
        if (conversation.data.unread_by_admin > 0) {
          await admin
            .from("support_conversations")
            .update({ unread_by_admin: 0 })
            .eq("id", conversationId);
        }
        return json({
          data: {
            conversation: {
              id: conversation.data.id,
              status: conversation.data.status,
              humanRequestedAt: conversation.data.human_requested_at,
              member: profile.data
                ? {
                    id: profile.data.id,
                    name:
                      [profile.data.first_name, profile.data.surname].filter(Boolean).join(" ") ||
                      "Unknown member",
                    accountId: profile.data.account_id,
                    email: profile.data.email,
                    phone: profile.data.phone,
                  }
                : null,
            },
            messages: (messages.data ?? []).map(supportMessage),
          },
        });
      }

      case "adminSendSupportReply": {
        await assertAdmin(supabase, userId);
        const conversationId = requireString(data.conversationId, "conversation", 36, 36);
        const message = requireString(data.message, "support reply", 1, 2000);
        const conversation = await admin
          .from("support_conversations")
          .select("*")
          .eq("id", conversationId)
          .maybeSingle();
        if (conversation.error || !conversation.data)
          throw new Error(conversation.error?.message ?? "Support conversation not found");
        const inserted = await admin.from("support_messages").insert({
          conversation_id: conversationId,
          sender_type: "admin",
          sender_user_id: userId,
          body: message,
        });
        if (inserted.error) throw new Error(inserted.error.message);
        const now = new Date().toISOString();
        const updated = await admin
          .from("support_conversations")
          .update({
            status: "admin_active",
            assigned_admin_id: userId,
            unread_by_admin: 0,
            unread_by_user: Number(conversation.data.unread_by_user ?? 0) + 1,
            last_message_at: now,
            updated_at: now,
          })
          .eq("id", conversationId);
        if (updated.error) throw new Error(updated.error.message);
        return json({ data: { ok: true } });
      }

      case "adminCloseSupportConversation": {
        await assertAdmin(supabase, userId);
        const conversationId = requireString(data.conversationId, "conversation", 36, 36);
        const conversation = await admin
          .from("support_conversations")
          .select("status,unread_by_user")
          .eq("id", conversationId)
          .maybeSingle();
        if (conversation.error || !conversation.data)
          throw new Error(conversation.error?.message ?? "Support conversation not found");
        if (conversation.data.status !== "closed") {
          const systemMessage = await admin.from("support_messages").insert({
            conversation_id: conversationId,
            sender_type: "system",
            sender_user_id: userId,
            body: "This support conversation was closed. Send a new message whenever you need more help.",
          });
          if (systemMessage.error) throw new Error(systemMessage.error.message);
          const now = new Date().toISOString();
          const updated = await admin
            .from("support_conversations")
            .update({
              status: "closed",
              unread_by_admin: 0,
              unread_by_user: Number(conversation.data.unread_by_user ?? 0) + 1,
              last_message_at: now,
              updated_at: now,
            })
            .eq("id", conversationId);
          if (updated.error) throw new Error(updated.error.message);
        }
        return json({ data: { ok: true } });
      }

      case "adminGetUserCount": {
        await assertAdmin(supabase, userId);
        const result = await admin.rpc("admin_user_counts");
        if (result.error) throw new Error(result.error.message);
        return json({ data: result.data });
      }

      case "adminGetWalletOverview": {
        await assertAdmin(supabase, userId);
        // A historical auth-user deletion can leave a legacy tranche behind.
        // It must never be included in an admin headline because it has no
        // current member card against which the amount can be reconciled.
        const profileRows = await readAllRows<any>((from, to) => admin
          .from("profiles")
          .select("id,account_id,first_name,surname,email")
          .order("id").range(from, to));
        const activeProfileIds = new Set(profileRows.map((profile: any) => profile.id));
        const profileById = Object.fromEntries(
          profileRows.map((profile: any) => [profile.id, profile]),
        );
        const [wallets, tranches] = await Promise.all([
          readAllRows<any>((from, to) => admin.from("wallets").select("user_id,currency,balance")
            .order("user_id").order("currency").range(from, to)),
          readAllRows<any>((from, to) => admin
            .from("deposit_tranches")
            .select(
              "id,user_id,currency,amount,remaining,current_balance,status,maturity_date,cycle_label,growth_cycle_code,approved",
            )
            .gt("remaining", 0).order("id").range(from, to)),
        ]);
        const metricsByUser: Record<string, any> = {};
        const totals = { withdrawable: { ZAR: 0, USD: 0 }, growing: { ZAR: 0, USD: 0 } };
        const upcomingMaturities: any[] = [];
        const maturityAlertCutoff = Date.now() + 5 * 86_400_000;
        for (const wallet of wallets) {
          if (!activeProfileIds.has(wallet.user_id)) continue;
          const metrics = (metricsByUser[wallet.user_id] ??= {
            balances: {},
            locked: {},
            growing: {},
            activeTranches: [],
          });
          metrics.balances[wallet.currency] = Number(wallet.balance ?? 0);
        }
        for (const tranche of tranches) {
          if (!activeProfileIds.has(tranche.user_id)) continue;
          if ((tranche.status ?? "locked") !== "locked") continue;
          const metrics = (metricsByUser[tranche.user_id] ??= {
            balances: {},
            locked: {},
            growing: {},
            activeTranches: [],
          });
          metrics.locked[tranche.currency] =
            (metrics.locked[tranche.currency] ?? 0) + Number(tranche.remaining ?? 0);
          metrics.growing[tranche.currency] =
            (metrics.growing[tranche.currency] ?? 0) +
            Number(tranche.current_balance ?? tranche.remaining ?? 0);
          if (tranche.approved === true) {
            const activeTranche = {
              id: tranche.id,
              currency: tranche.currency,
              amount: Number(tranche.amount ?? 0),
              remaining: Number(tranche.remaining ?? 0),
              currentBalance: Number(tranche.current_balance ?? tranche.remaining ?? 0),
              maturityDate: tranche.maturity_date,
              cycleLabel: tranche.cycle_label ?? null,
              growthCycleCode: tranche.growth_cycle_code ?? null,
            };
            metrics.activeTranches.push(activeTranche);
            const maturityTime = new Date(tranche.maturity_date).getTime();
            if (Number.isFinite(maturityTime) && maturityTime <= maturityAlertCutoff) {
              const profile = profileById[tranche.user_id];
              upcomingMaturities.push({
                ...activeTranche,
                userId: tranche.user_id,
                accountId: profile?.account_id ?? "Unknown",
                userName:
                  [profile?.first_name, profile?.surname].filter(Boolean).join(" ") ||
                  "Unknown user",
                userEmail: profile?.email ?? null,
              });
            }
          }
        }
        for (const metrics of Object.values(metricsByUser) as any[]) {
          metrics.withdrawable = {};
          metrics.activeTranches.sort(
            (a: any, b: any) =>
              new Date(a.maturityDate).getTime() - new Date(b.maturityDate).getTime(),
          );
          for (const currency of ["ZAR", "USD"]) {
            metrics.withdrawable[currency] = Math.max(
              0,
              Number(metrics.balances[currency] ?? 0) - Number(metrics.locked[currency] ?? 0),
            );
            totals.withdrawable[currency as "ZAR" | "USD"] += metrics.withdrawable[currency];
            totals.growing[currency as "ZAR" | "USD"] += Number(metrics.growing[currency] ?? 0);
          }
        }
        upcomingMaturities.sort(
          (a, b) => new Date(a.maturityDate).getTime() - new Date(b.maturityDate).getTime(),
        );
        return json({ data: { totals, metricsByUser, upcomingMaturities } });
      }

      case "adminListUsers": {
        await assertAdmin(supabase, userId);
        const search = typeof data.search === "string" ? data.search.trim().slice(0, 100) : "";
        const userRows = await readAllRows<any>((from, to) => {
          let query = admin
          .from("profiles")
          .select(
            "id,account_id,first_name,surname,email,phone,created_at,account_frozen,frozen_at,freeze_reason",
          )
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to);
        if (search) {
          const safe = search.replace(/[%(),]/g, "");
          query = query.or(
            `first_name.ilike.%${safe}%,surname.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%,account_id.ilike.%${safe}%,id.eq.${/^[0-9a-f-]{36}$/i.test(safe) ? safe : "00000000-0000-0000-0000-000000000000"}`,
          );
        }
          return query;
        });
        const ids = userRows.map((profile: any) => profile.id);
        const disputes: any[] = [];
        const presence: any[] = [];
        // Bound URL length and page each batch so multiple disputes cannot hide users.
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const [batchDisputes, batchPresence] = await Promise.all([
              readAllRows<any>((from, to) => admin
                .from("account_freeze_disputes")
                .select("*")
                .in("user_id", batch)
                .order("created_at", { ascending: false }).order("id").range(from, to)),
              readAllRows<any>((from, to) => admin.from("user_presence")
                .select("user_id,last_seen_at").in("user_id", batch)
                .order("user_id").range(from, to)),
          ]);
          disputes.push(...batchDisputes);
          presence.push(...batchPresence);
        }
        const latestByUser: Record<string, any> = {};
        for (const dispute of disputes) {
          if (!latestByUser[dispute.user_id]) latestByUser[dispute.user_id] = dispute;
        }
        const lastSeenByUser = Object.fromEntries(
          presence.map((entry: any) => [entry.user_id, entry.last_seen_at]),
        );
        const onlineCutoff = Date.now() - 2 * 60_000;
        const usersByRecentActivity = userRows
          .map((profile: any) => {
            const lastSeenAt = lastSeenByUser[profile.id] ?? null;
            return {
              ...profile,
              latest_dispute: latestByUser[profile.id] ?? null,
              last_seen_at: lastSeenAt,
              is_online: Boolean(lastSeenAt && new Date(lastSeenAt).getTime() >= onlineCutoff),
            };
          })
          .sort((a: any, b: any) => {
            const aLastSeen = a.last_seen_at
              ? new Date(a.last_seen_at).getTime()
              : Number.NEGATIVE_INFINITY;
            const bLastSeen = b.last_seen_at
              ? new Date(b.last_seen_at).getTime()
              : Number.NEGATIVE_INFINITY;
            if (aLastSeen !== bLastSeen) return bLastSeen - aLastSeen;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
        return json({ data: { users: usersByRecentActivity } });
      }

      case "adminSetAccountFrozen": {
        await assertAdmin(supabase, userId);
        const targetUserId = requireString(data.userId, "user", 36, 36);
        const frozen = data.frozen === true;
        const reason = frozen ? requireString(data.reason, "freeze reason", 5, 500) : null;
        const adminNote =
          typeof data.adminNote === "string" ? data.adminNote.trim().slice(0, 1000) : null;
        const result = await supabase.rpc("admin_set_account_frozen", {
          p_user_id: targetUserId,
          p_frozen: frozen,
          p_reason: reason,
          p_admin_note: adminNote,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "adminRejectAccountFreezeDispute": {
        await assertAdmin(supabase, userId);
        const disputeId = requireString(data.disputeId, "dispute", 36, 36);
        const adminNote = requireString(data.adminNote, "review note", 5, 1000);
        const result = await supabase.rpc("admin_reject_account_freeze_dispute", {
          p_dispute_id: disputeId,
          p_admin_note: adminNote,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "adminGetAccountDisputeUrl": {
        await assertAdmin(supabase, userId);
        const path = requireString(data.path, "document path", 3, 500);
        const signed = await admin.storage.from("account-disputes").createSignedUrl(path, 300);
        if (signed.error) throw new Error(signed.error.message);
        return json({ data: { url: signed.data.signedUrl } });
      }

      case "adminDeleteUserAndBanEmail": {
        await assertAdmin(supabase, userId);
        const targetUserId = requireString(data.userId, "user", 36, 36);
        if (targetUserId === userId) throw new Error("You cannot delete your own admin account");

        const profile = await admin
          .from("profiles")
          .select("id,email")
          .eq("id", targetUserId)
          .maybeSingle();
        if (profile.error) throw new Error(profile.error.message);
        if (!profile.data) throw new Error("User not found");
        const bannedEmail = String(profile.data.email ?? "")
          .trim()
          .toLowerCase();
        if (!bannedEmail || bannedEmail.length > 320)
          throw new Error("User has no valid email to ban");

        const ban = await admin.from("admin_banned_emails").upsert(
          {
            email: bannedEmail,
            banned_user_id: targetUserId,
            banned_by: userId,
            banned_at: new Date().toISOString(),
          },
          { onConflict: "email" },
        );
        if (ban.error) throw new Error(ban.error.message);

        try {
          for (const bucket of ["kyc", "deposits", "insurance", "community", "account-disputes"]) {
            const listed = await admin.storage.from(bucket).list(targetUserId, { limit: 1000 });
            if (listed.error)
              throw new Error(`Could not inspect ${bucket} files: ${listed.error.message}`);
            if (listed.data?.length) {
              const removed = await admin.storage
                .from(bucket)
                .remove(listed.data.map((file: any) => `${targetUserId}/${file.name}`));
              if (removed.error)
                throw new Error(`Could not remove ${bucket} files: ${removed.error.message}`);
            }
          }

          await admin
            .from("review_file_cleanup_queue")
            .delete()
            .like("object_path", `${targetUserId}/%`);
          await admin
            .from("insurance_claims")
            .update({ reviewed_by: null })
            .eq("reviewed_by", targetUserId);
          await admin
            .from("insurance_applications")
            .update({ reviewed_by: null })
            .eq("reviewed_by", targetUserId);
          const deleted = await admin.auth.admin.deleteUser(targetUserId);
          if (deleted.error) throw new Error(deleted.error.message);
        } catch (error) {
          await admin
            .from("admin_banned_emails")
            .delete()
            .eq("email", bannedEmail)
            .eq("banned_user_id", targetUserId);
          throw error;
        }

        return json({ data: { ok: true, bannedEmail } });
      }

      case "adminRegisterBonusTestDevice": {
        await assertAdmin(supabase, userId);
        const installationId = requireString(data.installationId, "installation", 36, 36);
        if (!/^[0-9a-f-]{36}$/i.test(installationId)) throw new Error("Invalid installation");
        const label = requireString(data.label, "device label", 3, 80);
        const result = await admin.from("bonus_test_installations").upsert(
          {
            signal_hash: await sha256(installationId),
            label,
            registered_by: userId,
          },
          { onConflict: "signal_hash" },
        );
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "adminListInsuranceApplications": {
        await assertAdmin(supabase, userId);
        const rows = await admin
          .from("insurance_applications")
          .select("*")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(100);
        if (rows.error) throw new Error(rows.error.message);
        const ids = Array.from(new Set((rows.data ?? []).map((x: any) => x.user_id)));
        const profiles = ids.length
          ? await admin
              .from("profiles")
              .select("id,account_id,first_name,surname,email,phone")
              .in("id", ids)
          : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({
          data: {
            applications: (rows.data ?? []).map((x: any) => ({
              ...x,
              profiles: byId[x.user_id] ?? null,
            })),
          },
        });
      }

      case "adminListInsuranceClaims": {
        await assertAdmin(supabase, userId);
        const rows = await admin
          .from("insurance_claims")
          .select("*")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(100);
        if (rows.error) throw new Error(rows.error.message);
        const ids = Array.from(new Set((rows.data ?? []).map((x: any) => x.user_id)));
        const profiles = ids.length
          ? await admin
              .from("profiles")
              .select("id,account_id,first_name,surname,email,phone")
              .in("id", ids)
          : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({
          data: {
            claims: (rows.data ?? []).map((x: any) => ({
              ...x,
              profiles: byId[x.user_id] ?? null,
            })),
          },
        });
      }

      case "adminGetInsuranceDocumentUrl": {
        await assertAdmin(supabase, userId);
        const path = requireString(data.path, "document path", 3, 500);
        const signed = await admin.storage.from("insurance").createSignedUrl(path, 300);
        if (signed.error) throw new Error(signed.error.message);
        await recordAdminFileView(admin, userId, "insurance", path);
        return json({ data: { url: signed.data.signedUrl } });
      }

      case "adminReviewInsuranceApplication": {
        await assertAdmin(supabase, userId);
        const applicationId = requireString(data.applicationId, "application", 36, 36);
        const status =
          data.status === "approved" ? "approved" : data.status === "declined" ? "declined" : null;
        if (!status) throw new Error("Invalid status");
        const credit = status === "approved" ? requireAmount(data.creditAmount, 1_000_000) : 0;
        const note = typeof data.note === "string" ? data.note.trim().slice(0, 500) : null;
        const result = await supabase.rpc("admin_review_insurance_application", {
          p_application_id: applicationId,
          p_status: status,
          p_credit: credit,
          p_note: note,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "adminReviewInsuranceClaim": {
        await assertAdmin(supabase, userId);
        const claimId = requireString(data.claimId, "claim", 36, 36);
        const status =
          data.status === "approved" ? "approved" : data.status === "declined" ? "declined" : null;
        if (!status) throw new Error("Invalid status");
        const approved = status === "approved" ? requireAmount(data.approvedAmount, 1_000_000) : 0;
        const note = typeof data.note === "string" ? data.note.trim().slice(0, 500) : null;
        const result = await supabase.rpc("admin_review_insurance_claim", {
          p_claim_id: claimId,
          p_status: status,
          p_approved_amount: approved,
          p_note: note,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "sendOtps": {
        await supabase
          .from("otp_codes")
          .update({ consumed: true })
          .eq("user_id", userId)
          .eq("consumed", false);
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const { error } = await supabase
          .from("otp_codes")
          .insert({ user_id: userId, channel: "email", code });
        if (error) throw new Error(error.message);
        const profile = await supabase
          .from("profiles")
          .select("email, first_name")
          .eq("id", userId)
          .maybeSingle();
        const delivered = profile.data?.email
          ? await sendEmail(
              profile.data.email,
              "Your Sparkle Insure verification code",
              `Hi ${profile.data.first_name ?? ""},\n\nYour Sparkle Insure verification code is: ${code}\n\nThis code expires shortly. If you did not request it, please ignore this email.`,
            )
          : false;
        return json({ data: { ok: true, delivered } });
      }

      case "verifyOtps": {
        throw new Error("Identity reviews are approved by an administrator after document review");
      }

      case "adminLookupUser": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const profile = await supabase
          .from("profiles")
          .select("*")
          .eq("account_id", accountId)
          .maybeSingle();
        if (profile.error) throw new Error(profile.error.message);
        if (!profile.data)
          return json({ data: { profile: null, wallets: [], transactions: [], tranches: [] } });
        const maturity = await admin.rpc("settle_due_tranches_for_user", {
          p_user_id: profile.data.id,
        });
        if (maturity.error) throw new Error(maturity.error.message);
        const [wallets, transactions, tranches] = await Promise.all([
          supabase.from("wallets").select("*").eq("user_id", profile.data.id).order("currency"),
          supabase
            .from("transactions")
            .select("*")
            .eq("user_id", profile.data.id)
            .order("created_at", { ascending: false })
            .limit(50),
          supabase
            .from("deposit_tranches")
            .select("*")
            .eq("user_id", profile.data.id)
            .gt("remaining", 0)
            .order("created_at"),
        ]);
        return json({
          data: {
            profile: profile.data,
            wallets: wallets.data ?? [],
            transactions: transactions.data ?? [],
            tranches: tranches.data ?? [],
          },
        });
      }

      case "adminListActiveTranches": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const currency = requireCurrency(data.currency);
        const profile = await supabase
          .from("profiles")
          .select("id")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!profile.data) return json({ data: { tranches: [] } });
        const tranches = await supabase
          .from("deposit_tranches")
          .select("*")
          .eq("user_id", profile.data.id)
          .eq("currency", currency)
          .gt("remaining", 0)
          .gt("maturity_date", new Date().toISOString())
          .order("created_at");
        if (tranches.error) throw new Error(tranches.error.message);
        return json({ data: { tranches: tranches.data ?? [] } });
      }

      case "adminCreditBonus": {
        await assertAdmin(supabase, userId);
        const accountId = requireString(data.accountId, "account ID", 3, 20).toUpperCase();
        const currency = requireCurrency(data.currency);
        const amount = requireAmount(data.amount, 1_000_000);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const holdRule =
          data.holdRule === "attach" ? "attach" : data.holdRule === "instant" ? "instant" : null;
        if (!holdRule) throw new Error("Invalid hold rule");
        const profile = await supabase
          .from("profiles")
          .select("id")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!profile.data) throw new Error("Account not found");
        const targetId = profile.data.id;
        const secureCredit = await supabase.rpc("admin_credit_bonus_idempotent_secure", {
          p_user_id: targetId,
          p_currency: currency,
          p_amount: amount,
          p_note: typeof data.note === "string" ? data.note.slice(0, 200) : null,
          p_hold_rule: holdRule,
          p_parent_tranche_id:
            holdRule === "attach" ? requireString(data.parentTrancheId, "tranche", 1, 100) : null,
          p_request_id: requestId,
        });
        if (secureCredit.error) throw new Error(secureCredit.error.message);
        return json({ data: { ok: true, balance: secureCredit.data } });

        /* Legacy flow retained below for historical source context; unreachable. */
        let maturityDate = new Date().toISOString();
        let parentTrancheId: string | null = null;
        if (holdRule === "attach") {
          const parentId = requireString(data.parentTrancheId, "tranche", 1, 100);
          const parent = await supabase
            .from("deposit_tranches")
            .select("*")
            .eq("id", parentId)
            .eq("user_id", targetId)
            .maybeSingle();
          if (!parent.data) throw new Error("Tranche not found");
          maturityDate = parent.data.maturity_date;
          parentTrancheId = parent.data.id;
        }
        const wallet = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", targetId)
          .eq("currency", currency)
          .maybeSingle();
        const balance = Number(wallet.data?.balance ?? 0) + amount;
        const walletWrite = wallet.data
          ? await supabase
              .from("wallets")
              .update({ balance, updated_at: new Date().toISOString() })
              .eq("user_id", targetId)
              .eq("currency", currency)
          : await supabase.from("wallets").insert({ user_id: targetId, currency, balance });
        if (walletWrite.error) throw new Error(walletWrite.error.message);
        const note = typeof data.note === "string" ? data.note.slice(0, 200) : "";
        const tx = await supabase
          .from("transactions")
          .insert({
            user_id: targetId,
            type: "bonus",
            currency,
            amount,
            status: "completed",
            description: `${note || "Bonus credit from admin"}${holdRule === "attach" ? " (attached to tranche)" : " (instant release)"}`,
          })
          .select("id")
          .maybeSingle();
        if (tx.error) throw new Error(tx.error.message);
        const tranche = await supabase.from("deposit_tranches").insert({
          user_id: targetId,
          currency,
          amount,
          remaining: amount,
          current_balance: amount,
          status: holdRule === "instant" ? "matured" : "locked",
          source: "bonus",
          parent_tranche_id: parentTrancheId,
          transaction_id: tx.data?.id ?? null,
          note: note || null,
          maturity_date: maturityDate,
        });
        if (tranche.error) throw new Error(tranche.error.message);
        return json({ data: { ok: true, balance } });
      }

      case "adminDeductWithdrawable": {
        await assertAdmin(supabase, userId);
        const targetUserId = requireString(data.userId, "user", 36, 36);
        const currency = requireCurrency(data.currency);
        const debitKind =
          data.debitKind === "insurance_repayment"
            ? "insurance_repayment"
            : data.debitKind === "account_adjustment"
              ? "account_adjustment"
              : null;
        if (!debitKind) throw new Error("Invalid deduction type");
        const resetToZero = data.resetToZero === true;
        if (debitKind === "insurance_repayment" && (currency !== "ZAR" || resetToZero)) {
          throw new Error("Insurance repayments must be a specific ZAR amount");
        }
        const amount = resetToZero ? null : requireAmount(data.amount);
        const reason = requireString(data.reason, "deduction reason", 5, 500);
        const requestId = requireString(data.requestId, "request ID", 36, 36);
        const result = await supabase.rpc("admin_debit_withdrawable_secure", {
          p_user_id: targetUserId,
          p_currency: currency,
          p_amount: amount,
          p_debit_kind: debitKind,
          p_reason: reason,
          p_reset_to_zero: resetToZero,
          p_request_id: requestId,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: result.data });
      }

      case "adminListPendingDeposits": {
        await assertAdmin(supabase, userId);
        const txs = await supabase
          .from("transactions")
          .select("*")
          .eq("type", "deposit")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(100);
        if (txs.error) throw new Error(txs.error.message);
        const ids = [...new Set((txs.data ?? []).map((t: any) => t.user_id))];
        const profiles = ids.length
          ? await supabase
              .from("profiles")
              .select("id, account_id, first_name, surname, email")
              .in("id", ids)
          : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({
          data: {
            deposits: (txs.data ?? []).map((t: any) => ({
              ...t,
              profiles: byId[t.user_id] ?? null,
            })),
          },
        });
      }

      case "adminListRecruiterApplications": {
        await assertAdmin(supabase, userId);
        const result = await supabase.rpc("admin_list_recruiter_applications");
        if (result.error) throw new Error(result.error.message);
        return json({ data: { applications: result.data ?? [] } });
      }

      case "adminReviewRecruiterApplication": {
        await assertAdmin(supabase, userId);
        const applicationId = requireString(data.applicationId, "application", 36, 36);
        const status = requireString(data.status, "decision", 7, 10);
        if (!["approved", "declined", "suspended"].includes(status))
          throw new Error("Invalid recruiter decision");
        const result = await supabase.rpc("admin_review_recruiter_application", {
          p_application_id: applicationId,
          p_status: status,
          p_note: typeof data.note === "string" ? data.note.slice(0, 500) : null,
        });
        if (result.error) throw new Error(result.error.message);
        return json({ data: { ok: true } });
      }

      case "adminGetProofUrl": {
        await assertAdmin(supabase, userId);
        const path = requireString(data.path, "proof path", 1, 500);
        const signed = await supabase.storage.from("deposits").createSignedUrl(path, 300);
        if (signed.error) throw new Error(signed.error.message);
        await recordAdminFileView(admin, userId, "deposits", path);
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
        await recordAdminFileView(admin, userId, "kyc", path);
        return json({ data: { url: signed.data.signedUrl } });
      }

      case "adminVerifyDeposit": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const cycleCode = data.cycleCode == null ? null : requireGrowthCycle(data.cycleCode);
        const approved = await supabase.rpc("admin_approve_deposit_secure", {
          p_tx_id: txId,
          p_corrected_amount:
            data.correctedAmount == null ? null : requireAmount(data.correctedAmount),
          p_note: typeof data.note === "string" ? data.note.slice(0, 300) : null,
          p_cycle_code: cycleCode,
        });
        if (approved.error) throw new Error(approved.error.message);
        return json({ data: { ok: true, approvedAmount: approved.data } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.status !== "pending")
          throw new Error("Transaction not found or already processed");
        const corrected =
          data.correctedAmount == null
            ? Number(tx.data.amount)
            : requireAmount(data.correctedAmount);
        const delta = corrected - Number(tx.data.amount);
        const note = typeof data.note === "string" ? data.note.slice(0, 300) : "";
        const updated = await supabase
          .from("transactions")
          .update({
            status: "completed",
            description: `Deposit verified by admin${note ? ` — ${note}` : ""}`,
          })
          .eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        await supabase
          .from("deposit_tranches")
          .update({
            approved: true,
            created_at: new Date().toISOString(),
            maturity_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            ...(delta !== 0
              ? { amount: corrected, remaining: corrected, current_balance: corrected }
              : {}),
          })
          .eq("transaction_id", txId);
        if (delta !== 0) {
          const wallet = await supabase
            .from("wallets")
            .select("balance")
            .eq("user_id", tx.data.user_id)
            .eq("currency", tx.data.currency)
            .maybeSingle();
          const next = Number(wallet.data?.balance ?? 0) + delta;
          const upd = await supabase
            .from("wallets")
            .update({ balance: next, updated_at: new Date().toISOString() })
            .eq("user_id", tx.data.user_id)
            .eq("currency", tx.data.currency);
          if (upd.error) throw new Error(upd.error.message);
          const adjustment = await supabase.from("transactions").insert({
            user_id: tx.data.user_id,
            type: "adjustment",
            currency: tx.data.currency,
            amount: delta,
            status: "completed",
            reference: tx.data.reference,
            description: `Admin correction on deposit${note ? ` — ${note}` : ""}`,
          });
          if (adjustment.error) throw new Error(adjustment.error.message);
        }
        return json({ data: { ok: true, delta } });
      }

      case "adminDeclineDeposit": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const declined = await supabase.rpc("admin_decline_deposit_secure", {
          p_tx_id: txId,
          p_reason: typeof data.reason === "string" ? data.reason.slice(0, 300) : null,
        });
        if (declined.error) throw new Error(declined.error.message);
        return json({ data: { ok: true } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.type !== "deposit" || tx.data.status !== "pending")
          throw new Error("Transaction not found or already processed");
        const wallet = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", tx.data.user_id)
          .eq("currency", tx.data.currency)
          .maybeSingle();
        const updatedWallet = await supabase
          .from("wallets")
          .update({
            balance: Math.max(0, Number(wallet.data?.balance ?? 0) - Number(tx.data.amount)),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", tx.data.user_id)
          .eq("currency", tx.data.currency);
        if (updatedWallet.error) throw new Error(updatedWallet.error.message);
        await supabase.from("deposit_tranches").delete().eq("transaction_id", txId);
        const reason = typeof data.reason === "string" ? data.reason.slice(0, 300) : "";
        const updated = await supabase
          .from("transactions")
          .update({
            status: "declined",
            description: `Deposit declined by admin${reason ? ` — ${reason}` : ""}`,
          })
          .eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        return json({ data: { ok: true } });
      }

      case "adminListPendingWithdrawals": {
        await assertAdmin(supabase, userId);
        const txs = await supabase
          .from("transactions")
          .select("*")
          .eq("type", "withdrawal")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(200);
        if (txs.error) throw new Error(txs.error.message);
        const ids = [...new Set((txs.data ?? []).map((t: any) => t.user_id))];
        const profiles = ids.length
          ? await supabase
              .from("profiles")
              .select(
                "id, account_id, first_name, surname, email, phone, bank_name, bank_account_number",
              )
              .in("id", ids)
          : { data: [] };
        const byId = Object.fromEntries((profiles.data ?? []).map((p: any) => [p.id, p]));
        return json({
          data: {
            withdrawals: (txs.data ?? []).map((t: any) => ({
              ...t,
              profiles: byId[t.user_id] ?? null,
            })),
          },
        });
      }

      case "adminCompleteWithdrawal": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const completed = await supabase.rpc("admin_complete_withdrawal_secure", {
          p_tx_id: txId,
          p_note: typeof data.note === "string" ? data.note.slice(0, 300) : null,
        });
        if (completed.error) throw new Error(completed.error.message);
        return json({ data: { ok: true } });

        /* Legacy flow retained below for historical source context; unreachable. */
        const tx = await supabase.from("transactions").select("*").eq("id", txId).maybeSingle();
        if (!tx.data || tx.data.type !== "withdrawal" || tx.data.status !== "pending")
          throw new Error("Withdrawal not found or already processed");
        const note = typeof data.note === "string" ? data.note.slice(0, 300) : "";
        const updated = await supabase
          .from("transactions")
          .update({
            status: "completed",
            description: `Withdrawal approved - Paid${note ? ` — ${note}` : ""}`,
          })
          .eq("id", txId);
        if (updated.error) throw new Error(updated.error.message);
        return json({ data: { ok: true } });
      }

      case "adminRefundWithdrawal": {
        await assertAdmin(supabase, userId);
        const txId = requireString(data.txId, "transaction", 36, 36);
        const refunded = await supabase.rpc("admin_refund_withdrawal_secure", {
          p_tx_id: txId,
          p_note: typeof data.note === "string" ? data.note.slice(0, 300) : null,
        });
        if (refunded.error) throw new Error(refunded.error.message);
        return json({ data: { ok: true } });
      }

      case "adminSeedDemo": {
        throw new Error("Demo seeding is disabled in production");

        /* Legacy flow retained below for historical source context; unreachable. */
        await assertAdmin(supabase, userId);
        const existing = await admin
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .like("email", "demo%@sparkleinsure.demo");
        if ((existing.count ?? 0) >= 5) return json({ data: { ok: true, seeded: 0 } });
        const demos = [
          ["Thabo", "Mokoena", "+27821110002", "ZAR", 18450],
          ["Sarah", "Johnson", "+14155550104", "USD", 3120],
          ["Linda", "Naidoo", "+27831110005", "ZAR", 62400],
          ["Michael", "Van Wyk", "+27831110006", "ZAR", 9840],
          ["Emily", "Carter", "+14155550107", "USD", 1560],
        ];
        let seeded = 0;
        for (let index = 0; index < demos.length; index += 1) {
          const [first, last, phone, currency, balance] = demos[index];
          const email = `demo${index + 1}@sparkleinsure.demo`;
          const created = await admin.auth.admin.createUser({
            email,
            password: `Demo!${crypto.randomUUID().slice(0, 8)}Aa1`,
            email_confirm: true,
            user_metadata: { first_name: first, surname: last, phone, primary_currency: currency },
          });
          if (created.error || !created.data.user) {
            console.error(created.error);
            continue;
          }
          const id = created.data.user.id;
          await admin.from("profiles").update({ kyc_status: "verified" }).eq("id", id);
          await admin
            .from("wallets")
            .update({ balance })
            .eq("user_id", id)
            .eq("currency", currency);
          seeded += 1;
        }
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
