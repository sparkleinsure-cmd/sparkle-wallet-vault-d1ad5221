import { formatMoney } from "@/lib/currency";

export type GrowthCycleCode = "15d" | "30d" | "180d" | "360d";

export type GrowthCycle = {
  code: GrowthCycleCode;
  label: string;
  shortLabel: string;
  termDays: number;
  minAmount: number;
  maxAmount: number;
  maturityMultiplier: number;
};

export const GROWTH_CYCLES: GrowthCycle[] = [
  {
    code: "15d",
    label: "15 Days",
    shortLabel: "15 days",
    termDays: 15,
    minAmount: 100,
    maxAmount: 900,
    maturityMultiplier: 1.2,
  },
  {
    code: "30d",
    label: "1 Month",
    shortLabel: "1 month",
    termDays: 30,
    minAmount: 1_000,
    maxAmount: 9_000,
    maturityMultiplier: 1.4,
  },
  {
    code: "180d",
    label: "6 Months",
    shortLabel: "6 months",
    termDays: 180,
    minAmount: 10_000,
    maxAmount: 19_000,
    maturityMultiplier: 7,
  },
  {
    code: "360d",
    label: "12 Months",
    shortLabel: "12 months",
    termDays: 360,
    minAmount: 20_000,
    maxAmount: 100_000,
    maturityMultiplier: 21,
  },
];

export function getGrowthCycle(code: GrowthCycleCode): GrowthCycle {
  return GROWTH_CYCLES.find((cycle) => cycle.code === code) ?? GROWTH_CYCLES[0];
}

export function validateCycleAmount(amount: number, cycle: GrowthCycle): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a valid amount";
  if (amount < cycle.minAmount) {
    return `Required amount for the ${cycle.label} cycle is at least ${formatMoney(cycle.minAmount, "ZAR")}.`;
  }
  if (amount > cycle.maxAmount) {
    return `Maximum amount for the ${cycle.label} cycle is ${formatMoney(cycle.maxAmount, "ZAR")}.`;
  }
  return null;
}

export function expectedCycleAmount(amount: number, cycle: GrowthCycle): number {
  return Math.round(amount * cycle.maturityMultiplier * 100) / 100;
}

export function estimatedMaturityDate(termDays: number, start = new Date()): Date {
  const result = new Date(start);
  result.setDate(result.getDate() + termDays);
  return result;
}

export function formatCycleDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(typeof value === "string" ? new Date(value) : value);
}
