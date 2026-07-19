import { supabase } from "@/integrations/supabase/client";

type Input<T> = { data: T };

async function call<T>(action: string, data?: unknown): Promise<T> {
  const result = await supabase.functions.invoke("app-api", { body: { action, data } });
  if (result.error) {
    // Supabase wraps non-2xx function responses. The JSON payload remains on
    // the context response, so surface the useful server message to the UI.
    const response = (result.error as any).context;
    if (response?.json) {
      const payload = await response.json().catch(() => null);
      if (payload?.error) throw new Error(payload.error);
    }
    throw new Error(result.error.message || "Request failed");
  }
  if (result.data?.error) throw new Error(result.data.error);
  return result.data?.data as T;
}

export const getMe = () => call<any>("getMe");
export const getStatementTransactions = ({ data }: Input<{ days: number }>) => call<any[]>("getStatementTransactions", data);
export const setPrimaryCurrency = ({ data }: Input<{ currency: string }>) => call<{ ok: true }>("setPrimaryCurrency", data);
export const creditDeposit = ({ data }: Input<{ amount: number; currency: string; reference: string; proofUrl: string }>) => call<any>("creditDeposit", data);
export const requestWithdrawal = ({ data }: Input<{ amount: number; currency: string; bankName?: string; accountNumber?: string; confirmBreak?: boolean }>) => call<any>("requestWithdrawal", data);
export const submitKycReview = ({ data }: Input<{ bankProofPath: string; selfiePath: string }>) =>
  call<{ ok: true; status: "pending" }>("submitKycReview", data);
export const deleteMyAccount = () => call<{ ok: true }>("deleteMyAccount");
export const sendOtps = () => call<{ ok: true; delivered: boolean }>("sendOtps");
export const verifyOtps = ({ data }: Input<{ emailCode: string }>) => call<{ ok: true }>("verifyOtps", data);

export const adminLookupUser = ({ data }: Input<{ accountId: string }>) => call<any>("adminLookupUser", data);
export const adminCreditBonus = ({ data }: Input<{ accountId: string; currency: string; amount: number; note?: string; holdRule: "attach" | "instant"; parentTrancheId?: string }>) => call<any>("adminCreditBonus", data);
export const adminListActiveTranches = ({ data }: Input<{ accountId: string; currency: string }>) => call<any>("adminListActiveTranches", data);
export const adminSeedDemo = () => call<any>("adminSeedDemo");
export const adminListPendingKyc = () => call<any>("adminListPendingKyc");
export const adminListPendingDeposits = () => call<any>("adminListPendingDeposits");
export const adminGetProofUrl = ({ data }: Input<{ path: string }>) => call<any>("adminGetProofUrl", data);
export const adminGetKycProofUrl = ({ data }: Input<{ path: string }>) => call<{ url: string }>("adminGetKycProofUrl", data);
export const adminVerifyDeposit = ({ data }: Input<{ txId: string; correctedAmount?: number; note?: string }>) => call<any>("adminVerifyDeposit", data);
export const adminDeclineDeposit = ({ data }: Input<{ txId: string; reason?: string }>) => call<any>("adminDeclineDeposit", data);
export const adminListPendingWithdrawals = () => call<any>("adminListPendingWithdrawals");
export const adminCompleteWithdrawal = ({ data }: Input<{ txId: string; note?: string }>) => call<any>("adminCompleteWithdrawal", data);
export const adminSetKycStatus = ({ data }: Input<{ userId: string; status: "verified" | "rejected" }>) => call<{ ok: true }>("adminSetKycStatus", data);
