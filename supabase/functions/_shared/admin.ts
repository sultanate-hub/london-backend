// Admin API for the hotspot backend (stateless — sessions live in admin_logs).
import { json, queryParams } from "./cors.ts";
import { getSupabase } from "./supabase.ts";
import { dateKey, revenueByDay, revenueByMonth, sumRevenue, type RevenueRow } from "./revenue.ts";
import { getPosStats } from "./pos.ts";

const SESSION_TIMEOUT = 5 * 60 * 1000;

type AdminCfg = { password: string; role: string; permissions: string[] };

function adminUsers(): Record<string, AdminCfg> {
  const raw = Deno.env.get("ADMIN_USERS");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (_) { /* fall through */ }
  }
  return {
    superadmin: {
      password: Deno.env.get("ADMIN_SUPER_PASS") || "london-super-2026",
      role: "super_admin",
      permissions: ["delete", "create", "update", "extend", "manage_users", "export", "force_logout"],
    },
    admin: {
      password: Deno.env.get("ADMIN_VIEW_PASS") || "london-view-2026",
      role: "check",
      permissions: ["view"],
    },
  };
}

function permsOf(role: string): string[] {
  for (const cfg of Object.values(adminUsers())) {
    if (cfg.role === role) return cfg.permissions;
  }
  return ["view"];
}

async function validateSession(sessionId?: string | null) {
  if (!sessionId) return null;
  const sb = getSupabase();
  const { data } = await sb.from("admin_logs")
    .select("*").eq("session_id", sessionId).eq("is_active", true)
    .order("login_time", { ascending: false }).limit(1);
  const s = data?.[0];
  if (!s) return null;
  if (Date.now() - new Date(s.last_activity).getTime() > SESSION_TIMEOUT) {
    await sb.from("admin_logs").update({ is_active: false, logout_time: new Date().toISOString() }).eq("id", s.id);
    return null;
  }
  await sb.from("admin_logs").update({ last_activity: new Date().toISOString() }).eq("id", s.id);
  return s;
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return await req.json().catch(() => ({}));
}

async function fetchRevenueRows(sb: any): Promise<RevenueRow[]> {
  const page = 1000;
  let rows: RevenueRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from("payment_queue")
      .select("plan, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    rows = rows.concat((data ?? []) as RevenueRow[]);
    if (!data || data.length < page) break;
    from += page;
  }
  return rows;
}

export async function handleAdmin(req: Request, path: string): Promise<Response> {
  const method = req.method;
  const q = queryParams(req);
  const body = ["POST", "PATCH"].includes(method) ? await readJson(req) : {};
  const sessionId = (body.sessionId as string) || q.get("sessionId");

  // ---- login ----
  if (path === "/admin/api/login" && method === "POST") {
    const username = String(body.username || "");
    const password = String(body.password || "");
    const cfg = adminUsers()[username];
    if (!cfg || cfg.password !== password) return json({ success: false, error: "Invalid credentials" }, 401);
    const sb = getSupabase();
    await sb.from("admin_logs").update({ is_active: false, logout_time: new Date().toISOString() })
      .eq("username", username).eq("is_active", true);
    const sid = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 11);
    await sb.from("admin_logs").insert({
      username, role: cfg.role, session_id: sid, admin_ip: clientIp(req),
      user_agent: req.headers.get("user-agent") || "", login_time: new Date().toISOString(),
      last_activity: new Date().toISOString(), is_active: true,
    });
    return json({ success: true, sessionId: sid, username, role: cfg.role, permissions: cfg.permissions });
  }

  // everything below needs a session
  const session = await validateSession(sessionId);
  if (!session) return json({ error: "Unauthorized" }, 401);
  const can = (p: string) => (session.role === "super_admin") || permsOf(session.role).includes(p);

  if (path === "/admin/api/me" && method === "GET") {
    return json({ username: session.username, role: session.role, permissions: permsOf(session.role) });
  }

  if (path === "/admin/api/stats" && method === "GET") {
    const sb = getSupabase();
    const { data, error } = await sb.rpc("admin_stats");
    if (error) return json({ error: error.message }, 500);
    const stats: any = Array.isArray(data) ? data[0] : data;
    if (!stats) return json({ error: "Stats unavailable" }, 500);
    const rows = await fetchRevenueRows(sb);
    const today = dateKey(new Date());
    stats.revenue_lifetime = sumRevenue(rows);
    stats.total_revenue_lifetime = stats.revenue_lifetime;
    stats.revenue_today = sumRevenue(rows, today);
    stats.revenue_week = sumRevenue(rows, dateKey(new Date(Date.now() - 6 * 86400000)));
    stats.revenue_month = sumRevenue(rows, dateKey(new Date(Date.now() - 29 * 86400000)));
    try {
      stats.pos = await getPosStats(sb);
    } catch (posError) {
      console.error("POS stats error:", posError instanceof Error ? posError.message : posError);
      stats.pos = { connected: 0, total: 0, week: 0, month: 0, updated_at: null, clients: [] };
    }
    return json({ success: true, data: stats });
  }

  if (path === "/admin/api/daily" && method === "GET") {
    const month = q.get("month") || "";
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "Invalid month format. Use YYYY-MM." }, 400);
    const sb = getSupabase();
    const { data, error } = await sb.rpc("admin_daily", { p_month: month });
    if (error) return json({ error: error.message }, 500);
    const rows = await fetchRevenueRows(sb);
    const map = revenueByDay(rows, month);
    const out = (data ?? []).map((r: any) => ({ ...r, daily_total: map[Number(r.day)] ?? 0 }));
    return json({ success: true, data: out, month });
  }

  if (path === "/admin/api/activity" && method === "GET") {
    const hours = Math.min(168, Math.max(1, parseInt(q.get("hours") || "48", 10)));
    const limit = Math.min(500, Math.max(10, parseInt(q.get("limit") || "200", 10)));
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data, error } = await getSupabase().from("activity_log")
      .select("id, created_at, level, source, message, ref, username, mac")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, data, hours });
  }

  if (path === "/admin/api/monthly" && method === "GET") {
    const sb = getSupabase();
    const { data, error } = await sb.rpc("admin_monthly");
    if (error) return json({ error: error.message }, 500);
    const rows = await fetchRevenueRows(sb);
    const map = revenueByMonth(rows);
    const out = (data ?? []).map((r: any) => {
      const key = String(r.month_raw ?? r.month ?? (r.month_start ? String(r.month_start).slice(0, 7) : ""));
      return { ...r, revenue: map[key] ?? 0 };
    });
    return json({ success: true, data: out });
  }

  if (path === "/admin/api/users" && method === "GET") {
    const page = Math.max(1, parseInt(q.get("page") || "1", 10));
    const search = (q.get("search") || "").trim();
    const status = (q.get("status") || "").trim();
    const perPage = 100;
    const from = (page - 1) * perPage;
    let query = getSupabase().from("payment_queue")
      .select("id, transaction_id, mikrotik_username, mikrotik_password, plan, status, mac_address, customer_email, expires_at, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + perPage - 1);
    if (status && status !== "all") query = query.eq("status", status);
    if (search) query = query.or(`mikrotik_username.ilike.%${search}%,mac_address.ilike.%${search}%,customer_email.ilike.%${search}%`);
    const { data, count, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, data, total: count ?? 0, page, perPage });
  }

  if (path === "/admin/api/action" && method === "POST") {
    const action = String(body.action || "");
    const userId = body.userId;
    const sb = getSupabase();
    if (action === "delete") {
      if (!can("delete")) return json({ error: "Permission denied" }, 403);
      const { error } = await sb.from("payment_queue").delete().eq("id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, message: "User permanently deleted" });
    }
    if (action === "extend") {
      if (!can("extend")) return json({ error: "Permission denied" }, 403);
      const newPlan = String(body.newPlan || "");
      const hours: Record<string, number> = { "24hr": 24, "3d": 72, "5d": 120, "7d": 168, "14d": 336, "30d": 720 };
      if (!hours[newPlan]) return json({ error: "Invalid plan" }, 400);
      const { data } = await sb.from("payment_queue").select("expires_at").eq("id", userId).maybeSingle();
      const base = data?.expires_at && new Date(data.expires_at).getTime() > Date.now() ? new Date(data.expires_at) : new Date();
      const newExpiry = new Date(base.getTime() + hours[newPlan] * 3600 * 1000);
      const { error } = await sb.from("payment_queue")
        .update({ plan: newPlan, expires_at: newExpiry.toISOString(), status: "processed" }).eq("id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, message: `Extended to ${newPlan}`, expires_at: newExpiry.toISOString() });
    }
    if (action === "toggle") {
      if (!can("update")) return json({ error: "Permission denied" }, 403);
      const { data } = await sb.from("payment_queue").select("status").eq("id", userId).maybeSingle();
      const next = data?.status === "processed" ? "pending" : "processed";
      const { error } = await sb.from("payment_queue").update({ status: next }).eq("id", userId);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, message: `Status set to ${next}` });
    }
    return json({ error: "Unknown action" }, 400);
  }

  if (path === "/admin/api/sessions" && method === "GET") {
    const cfg = adminUsers();
    const out: Array<Record<string, unknown>> = [];
    for (const [username, c] of Object.entries(cfg)) {
      const { data } = await getSupabase().from("admin_logs")
        .select("*").eq("username", username).order("login_time", { ascending: false }).limit(1);
      const row = data?.[0];
      if (!row) {
        out.push({ username, role: c.role, has_session: false, is_current: false, is_active: false });
        continue;
      }
      const idle = Math.max(0, Math.floor((Date.now() - new Date(row.last_activity).getTime()) / 1000));
      out.push({
        username, role: c.role, ip: row.admin_ip, login_time: row.login_time,
        last_activity: row.last_activity, idle_seconds: idle,
        is_active: row.is_active, is_current: row.session_id === sessionId, has_session: true,
      });
    }
    return json({ success: true, data: out, active: out.filter((x) => x.is_active).length });
  }

  if (path === "/admin/api/logs" && method === "GET") {
    const { data, error } = await getSupabase().from("admin_logs")
      .select("username, role, admin_ip, login_time, last_activity, is_active")
      .order("login_time", { ascending: false }).limit(50);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, data });
  }

  if (path === "/admin/api/provider" && method === "GET") {
    const { data } = await getSupabase().from("app_settings").select("value").eq("key", "payment_provider").maybeSingle();
    return json({ success: true, provider: data?.value || "squad" });
  }
  if (path === "/admin/api/provider" && method === "POST") {
    if (!can("manage_users")) return json({ error: "Permission denied" }, 403);
    const provider = String(body.provider || "").toLowerCase();
    if (!["squad", "paystack"].includes(provider)) return json({ error: "Invalid provider" }, 400);
    const { error } = await getSupabase().from("app_settings")
      .upsert({ key: "payment_provider", value: provider, updated_at: new Date().toISOString() });
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, provider });
  }

  if (path === "/admin/api/contact-method" && method === "GET") {
    const { data } = await getSupabase().from("app_settings").select("value").eq("key", "contact_method").maybeSingle();
    const m = String(data?.value || "phone").toLowerCase();
    return json({ success: true, method: (m === "email" ? "email" : "phone") });
  }
  if (path === "/admin/api/contact-method" && method === "POST") {
    const method = String(body.method || "").toLowerCase();
    if (!["phone", "email"].includes(method)) return json({ error: "Invalid method" }, 400);
    const { error } = await getSupabase().from("app_settings")
      .upsert({ key: "contact_method", value: method, updated_at: new Date().toISOString() });
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, method });
  }

  if (path === "/admin/api/force-logout" && method === "POST") {
    if (session.role !== "super_admin") return json({ error: "Permission denied" }, 403);
    await getSupabase().from("admin_logs")
      .update({ is_active: false, logout_time: new Date().toISOString() })
      .eq("is_active", true).neq("session_id", sessionId);
    return json({ success: true, message: "All other sessions logged out" });
  }

  return json({ error: "Not found", path }, 404);
}
