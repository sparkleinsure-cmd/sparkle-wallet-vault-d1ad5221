import { useQuery } from "@tanstack/react-query";
import type { Currency } from "@/lib/currency";

// Free, no-auth exchange-rate feed. USD is base; returns { rates: { ZAR: 18.x, ... } }.
// Cached for 30 minutes; conservative fallback if the feed is unreachable.
const FALLBACK_USD_TO_ZAR = 18.5;

async function fetchUsdToZar(): Promise<number> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    const rate = Number(json?.rates?.ZAR);
    if (!isFinite(rate) || rate <= 0) throw new Error("bad rate");
    return rate;
  } catch {
    return FALLBACK_USD_TO_ZAR;
  }
}

export function useUsdToZarRate() {
  return useQuery({
    queryKey: ["fx", "USD_ZAR"],
    queryFn: fetchUsdToZar,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    placeholderData: FALLBACK_USD_TO_ZAR,
  });
}

/** Total value across ZAR + USD wallets expressed in the target display currency. */
export function convertTotal(
  zarBalance: number,
  usdBalance: number,
  usdToZar: number,
  target: Currency,
): number {
  if (target === "ZAR") return zarBalance + usdBalance * usdToZar;
  return zarBalance / usdToZar + usdBalance;
}