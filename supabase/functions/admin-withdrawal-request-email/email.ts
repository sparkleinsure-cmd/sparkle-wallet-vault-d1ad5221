export type WithdrawalAlert = {
  notification_id: string;
  transaction_id: string;
  account_id: string | null;
  user_name: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  currency: string;
  amount: number | string;
  submitted_at: string;
};

export function withdrawalEmailContent(alert: WithdrawalAlert) {
  const text = [
    "New withdrawal request",
    "",
    `Name: ${alert.user_name || "Not available"}`,
    `Account ID: ${alert.account_id || "Not available"}`,
    `Withdrawal amount: ${alert.currency} ${Number(alert.amount).toFixed(2)}`,
    `Bank: ${alert.bank_name || "Not available"}`,
    `Bank account number: ${alert.bank_account_number || "Not available"}`,
    `Withdrawal reference: ${alert.transaction_id}`,
    `Requested at: ${new Intl.DateTimeFormat("en-ZA", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg",
    }).format(new Date(alert.submitted_at))} SAST`,
    "",
    "Review the current request status in the Admin Console before making a payout:",
    "https://www.sparkleinsure.app/admin",
  ].join("\n");
  const escaped = text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return {
    subject: `Withdrawal request - ${(alert.account_id || alert.transaction_id).replace(/[\r\n]/g, " ")}`,
    text,
    html: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escaped}</div>`,
  };
}
