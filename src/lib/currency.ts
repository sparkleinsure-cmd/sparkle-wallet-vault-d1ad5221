export const CURRENCIES = ["ZAR", "NGN", "GHS", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CURRENCY_META: Record<Currency, { symbol: string; name: string; locale: string }> = {
  ZAR: { symbol: "R", name: "South African Rand", locale: "en-ZA" },
  NGN: { symbol: "₦", name: "Nigerian Naira", locale: "en-NG" },
  GHS: { symbol: "₵", name: "Ghanaian Cedi", locale: "en-GH" },
  USD: { symbol: "$", name: "US Dollar", locale: "en-US" },
};

export function formatMoney(amount: number, currency: Currency): string {
  const meta = CURRENCY_META[currency];
  try {
    return new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${meta.symbol}${amount.toFixed(2)}`;
  }
}