/**
 * Revenue calculation for the London admin dashboard.
 * Prices are the live London plan prices (24hr = ₦300).
 * Never uses the RPC's stale revenue table.
 */

export const PLAN_PRICES: Record<string, number> = {
  "24hr": 300,
  "3d": 1000,
  "5d": 1500,
  "7d": 2000,
  "14d": 3500,
  "30d": 5000,
};

export interface RevenueRow {
  plan?: string | null;
  created_at?: string | null;
}

export function priceOf(plan: unknown): number {
  return PLAN_PRICES[String(plan ?? "")] ?? 0;
}

const lagos = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dateKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  const parts = lagos.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Sum of plan prices, optionally only rows on/after YYYY-MM-DD (Lagos). */
export function sumRevenue(rows: RevenueRow[], sinceKey?: string): number {
  let total = 0;
  for (const row of rows) {
    const key = dateKey(row.created_at ?? "");
    if (!key) continue;
    if (sinceKey && key < sinceKey) continue;
    total += priceOf(row.plan);
  }
  return total;
}

export function revenueByMonth(rows: RevenueRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = dateKey(row.created_at ?? "");
    if (!key) continue;
    const month = key.slice(0, 7);
    out[month] = (out[month] ?? 0) + priceOf(row.plan);
  }
  return out;
}

export function revenueByDay(rows: RevenueRow[], month: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const row of rows) {
    const key = dateKey(row.created_at ?? "");
    if (!key || key.slice(0, 7) !== month) continue;
    const day = Number(key.slice(8, 10));
    out[day] = (out[day] ?? 0) + priceOf(row.plan);
  }
  return out;
}
