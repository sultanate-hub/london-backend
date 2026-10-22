/**
 * Mikhmon (manual hotspot voucher) -> payment_queue sync.
 *
 * Rule: a manual voucher appears on the dashboard after its FIRST login and
 * then stays there until its expiry. Unused vouchers never appear. Logging out
 * does not remove the row.
 *
 * The router sends all Mikhmon-pattern users plus the active-session list.
 * A user is eligible when they are active now OR their comment already carries
 * an expiry timestamp (written by Mikhmon's on-login script on first login).
 */

export interface MikhmonUserInput {
  name?: unknown;
  password?: unknown;
  profile?: unknown;
  mac?: unknown;
  "mac-address"?: unknown;
  comment?: unknown;
  disabled?: unknown;
  "limit-uptime"?: unknown;
  uptime?: unknown;
}

export interface MikhmonRow {
  transaction_id: string;
  customer_email: string;
  customer_phone: string;
  plan: string;
  mikrotik_username: string;
  mikrotik_password: string;
  mac_address: string;
  status: "processed" | "expired";
  expires_at: string | null;
}

export interface MikhmonSyncResult {
  received: number;
  eligible: number;
  skipped: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  names: string[];
  preview: Array<{ name: string; expires_at: string | null }>;
}

/** Maps Mikhmon voucher profile names to the plan codes used by the dashboards. */
export function mapMikhmonPlan(profile: unknown): string {
  const p = String(profile ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["24hr", "24hrs", "24-hour", "24-hours", "daily", "1d"].includes(p)) return "24hr";
  if (["3d", "3day", "3days", "3-day", "3-days"].includes(p)) return "3d";
  if (["5d", "5day", "5days", "5-day", "5-days"].includes(p)) return "5d";
  if (["7d", "7day", "7days", "7-day", "7-days", "1w", "weekly"].includes(p)) return "7d";
  if (["14d", "14day", "14days", "14-day", "14-days", "2w"].includes(p)) return "14d";
  if (["30d", "30day", "30days", "30-day", "30-days", "4w2d", "monthly"].includes(p)) return "30d";
  if (["6h", "6hour", "6hours", "6-hour", "6-hours"].includes(p)) return "6h";
  if (p === "default") return "default";
  // Safety net only: every profile actually in use on the routers is mapped above.
  return "other";
}

/**
 * Mikhmon writes an expiry timestamp into the user comment on first login
 * (e.g. "2026-10-22 18:22:00"). Voucher-code comments such as
 * "vc-137-10.22.26-4GBProfile" have no usable expiry and return null.
 */
export function parseMikhmonExpiry(comment: unknown): string | null {
  const text = String(comment ?? "");
  const m = text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2020 || year > 2100) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** RouterOS duration -> seconds ("1d00:00:00", "00:06:02", "1d", "0s"). */
export function routerSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // RouterOS :serialize turns a time limit into an epoch date ("1970-01-02 00:00:00").
  const epoch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (epoch) {
    const t = Date.parse(`${epoch[1]}-${epoch[2]}-${epoch[3]}T${epoch[4]}:${epoch[5]}:${epoch[6]}Z`);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const clock = raw.match(/^(?:(\d+)w)?(?:(\d+)d)?(\d{1,2}):(\d{2}):(\d{2})$/);
  if (clock) {
    return (Number(clock[1] ?? 0) * 604800) + (Number(clock[2] ?? 0) * 86400) +
      (Number(clock[3]) * 3600) + (Number(clock[4]) * 60) + Number(clock[5]);
  }
  const units = raw.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (units && /[wdhms]/.test(raw)) {
    return (Number(units[1] ?? 0) * 604800) + (Number(units[2] ?? 0) * 86400) +
      (Number(units[3] ?? 0) * 3600) + (Number(units[4] ?? 0) * 60) + Number(units[5] ?? 0);
  }
  return null;
}

export function toMikhmonRow(input: MikhmonUserInput): MikhmonRow | null {
  const name = String(input?.name ?? "").trim();
  if (!name) return null;

  const rawMac = String(input?.mac ?? input?.["mac-address"] ?? "").trim().toUpperCase();
  const mac = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(rawMac) ? rawMac : "";

  const disabled = String(input?.disabled ?? "").toLowerCase() === "true" ||
    String(input?.["limit-uptime"] ?? "") === "1s";

  // Manual vouchers must contribute to revenue exactly like the paid plans.
  // Every actual Mikhmon profile (24hr/3d/5d/7d/14d/30d/6h/default) is mapped.
  const mapped = mapMikhmonPlan(input?.profile);
  const contact = mapped === "other" ? "Mikhmon" : `Mikhmon (${mapped})`;

  return {
    transaction_id: `mikhmon-${name}`,
    customer_email: contact,
    customer_phone: "Mikhmon",
    plan: mapped,
    mikrotik_username: name,
    mikrotik_password: String(input?.password ?? ""),
    mac_address: mac,
    status: disabled ? "expired" : "processed",
    expires_at: parseMikhmonExpiry(input?.comment),
  };
}

const PAID_PLANS = new Set(["24hr", "3d", "5d", "7d", "14d", "30d"]);

/**
 * Inserts/updates eligible Mikhmon users. Never deletes: logout keeps the row,
 * and the dashboard turns it EXPIRED when expires_at passes.
 */
export async function syncMikhmonUsers(
  sb: any,
  users: MikhmonUserInput[],
  opts: { dryRun?: boolean; firstLoginOnly?: boolean; active?: string[] } = {},
): Promise<MikhmonSyncResult> {
  const activeSet = new Set((opts.active ?? []).map((x) => String(x)));
  const candidates = users.map(toMikhmonRow).filter((r): r is MikhmonRow => r !== null);
  // Only paid plans are allowed on the dashboard. 6-Hours, default and any
  // unrecognised profile are always excluded, even if the user logged in.
  const paid = candidates.filter((r) => PAID_PLANS.has(r.plan));
  const rows = opts.firstLoginOnly
    ? paid.filter((r) => activeSet.has(r.mikrotik_username) || r.expires_at !== null)
    : paid;
  const names = rows.map((r) => r.mikrotik_username);
  const result: MikhmonSyncResult = {
    received: users.length,
    eligible: rows.length,
    skipped: candidates.length - rows.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    names,
    preview: [],
  };

  if (opts.dryRun) return result;

  const { data: existing, error: readError } = await sb
    .from("payment_queue")
    .select("id, transaction_id, mikrotik_password, plan, mac_address, status, expires_at, created_at, customer_email, customer_phone")
    .like("transaction_id", "mikhmon-%");
  if (readError) throw new Error(readError.message || "Failed to read existing Mikhmon users");

  const byTx = new Map<string, any>();
  for (const row of existing ?? []) byTx.set(String(row.transaction_id), row);

  const sameDate = (a: unknown, b: string | null): boolean => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const ta = new Date(String(a)).getTime();
    const tb = new Date(String(b)).getTime();
    return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
  };

  const inputs = new Map<string, MikhmonUserInput>();
  for (const user of users) {
    const n = String(user?.name ?? "");
    if (n) inputs.set(n, user);
  }
  const preview: Array<{ name: string; expires_at: string | null }> = [];
  const applied = new Set<string>();

  for (const row of rows) {
    const input = inputs.get(row.mikrotik_username);
    const old = byTx.get(row.transaction_id);
    let expires = row.expires_at;
    // Never clear an expiry we already stored, and never extend it on a later
    // login: only the first login (or a timestamp written by Mikhmon) sets it.
    if (!expires && old?.expires_at) expires = String(old.expires_at);
    if (!expires) {
      const limit = routerSeconds(input?.["limit-uptime"]);
      const uptime = routerSeconds(input?.uptime);
      if (limit !== null && uptime !== null && limit > 0) {
        expires = new Date(Date.now() + Math.max(0, limit - uptime) * 1000).toISOString();
      }
    }
    const nextRow = { ...row, expires_at: expires };
    if (nextRow.expires_at) applied.add(row.transaction_id);
    if (preview.length < 5) preview.push({ name: row.mikrotik_username, expires_at: expires });

    if (old) {
      const unchanged =
        String(old.mikrotik_password ?? "") === nextRow.mikrotik_password &&
        String(old.plan ?? "") === nextRow.plan &&
        String(old.mac_address ?? "") === nextRow.mac_address &&
        String(old.status ?? "") === nextRow.status &&
        String(old.customer_email ?? "") === nextRow.customer_email &&
        String(old.customer_phone ?? "") === nextRow.customer_phone &&
        sameDate(old.expires_at, nextRow.expires_at);
      if (unchanged) {
        result.unchanged++;
        continue;
      }
      const { error } = await sb.from("payment_queue").update(nextRow).eq("id", old.id);
      if (error) result.failed++;
      else result.updated++;
    } else {
      const { error } = await sb.from("payment_queue").insert(nextRow);
      if (error) result.failed++;
      else result.created++;
    }
  }

  // Backfill rows whose first sync happened before the expiry was known (the
  // router on-login comment was not written). First seen + plan duration.
  for (const old of existing ?? []) {
    if (old.expires_at || applied.has(String(old.transaction_id))) continue;
    if (!old.created_at) continue;
    const input = inputs.get(String(old.mikrotik_username ?? ""));
    if (!input) continue;
    const limit = routerSeconds(input["limit-uptime"]);
    if (limit === null || limit <= 0) continue;
    const expires = new Date(new Date(String(old.created_at)).getTime() + limit * 1000).toISOString();
    const { error } = await sb.from("payment_queue").update({ expires_at: expires }).eq("id", old.id);
    if (!error) {
      result.updated++;
      if (preview.length < 5) preview.push({ name: String(old.mikrotik_username ?? ""), expires_at: expires });
    }
  }

  result.preview = preview;
  return result;
}
