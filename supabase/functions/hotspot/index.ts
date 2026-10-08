// hotspot edge function — port of the Dream Hatcher Express routes to Deno.
// Providers: Squad + Paystack (payment switch via app_settings / PAYMENT_PROVIDER).
//
// Paths (after /functions/v1/hotspot):
//   GET  /                                  portal
//   GET  /pay/:plan                         start a purchase
//   POST /api/initialize-payment            JSON purchase init
//   POST /api/squad-webhook                 Squad webhook
//   GET  /squad-callback                    Squad return URL
//   POST /api/paystack-webhook              Paystack webhook
//   GET  /paystack-callback                 Paystack return URL
//   GET  /success                           credentials polling page
//   GET  /api/check-status?ref=             status poll
//   GET  /api/get-token?ref=                token by reference
//   GET  /api/check-token                   creds by one-time token
//   GET  /api/check-email?email=            creds by email
//   GET  /api/mikrotik-queue-text           (router) pending users
//   POST /api/mark-processed/:id            (router) mark created
//   GET  /api/expired-users                 (router) expired users
//   POST /api/mark-expired/:id              (router) mark expired
//   GET  /health

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  handleCors,
  html,
  json,
  queryParams,
  rawBody,
  routePath,
  text,
} from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { handleAdmin } from "../_shared/admin.ts";

const PUBLIC_BASE = Deno.env.get("PUBLIC_BASE_URL") ||
  "https://pvslxeakzyhxfzlqakqg.supabase.co/functions/v1/hotspot";

// After payment, send the CUSTOMER back to the router's own hotspot portal
// (neutral URL). The portal already shows their credentials via /api/check-mac.
// (Do NOT send customers to the admin domain, and Supabase forces text/plain
// on function HTML, so we don't serve the page from the function either.)
const SUCCESS_PAGE = Deno.env.get("SUCCESS_PAGE_URL") || "http://192.168.88.1/login";

const planConfig: Record<string, { amount: number; code: string; duration: string; label: string }> = {
  daily: { amount: 300, code: "24hr", duration: "24 Hours", label: "Daily" },
  "3day": { amount: 1000, code: "3d", duration: "3 Days", label: "3-Day" },
  "5day": { amount: 1500, code: "5d", duration: "5 Days", label: "5-Day" },
  weekly: { amount: 2000, code: "7d", duration: "7 Days", label: "Weekly" },
  "2week": { amount: 3500, code: "14d", duration: "14 Days", label: "2-Week" },
  monthly: { amount: 5000, code: "30d", duration: "30 Days", label: "Monthly" },
};

const amountToPlan: Record<number, string> = {
  300: "24hr",
  1000: "3d",
  1500: "5d",
  2000: "7d",
  3500: "14d",
  5000: "30d",
};

// ---------- helpers ----------
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function generatePassword(length = 8): string {
  return hex(randBytes(length)).slice(0, length);
}
function oneTimeToken(): string {
  return hex(randBytes(32));
}
function generatePaymentReference(length = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = randBytes(length);
  let r = "";
  for (let i = 0; i < length; i++) r += chars[b[i] % chars.length];
  return r;
}
function expiryFromPlan(code: string): Date {
  const map: Record<string, number> = { "24hr": 24, "3d": 72, "5d": 120, "7d": 168, "14d": 336, "30d": 720 };
  const hours = map[code] ?? 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}
async function hmacHex(secret: string, message: string, hash = "SHA-512"): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(new Uint8Array(sig));
}

async function logActivity(
  source: string,
  message: string,
  opts: { level?: string; ref?: string; username?: string; mac?: string } = {},
): Promise<void> {
  try {
    await getSupabase().from("activity_log").insert({
      source,
      message,
      level: opts.level || "info",
      ref: opts.ref || null,
      username: opts.username || null,
      mac: opts.mac || null,
    });
  } catch (_) { /* never fail the main flow for logging */ }
}

// Payment providers require a valid email address. If the customer only gave a
// phone number, we synthesise a placeholder email so the charge can proceed;
// the real phone is stored on the order and in provider metadata.
function contactEmail(email?: string, phone?: string): string {
  if (email) return email;
  if (phone) return `${phone.replace(/[^0-9]/g, "")}@phone.local`;
  return "customer@dreamhatcher.com";
}

// ---------- payment providers ----------
async function initSquad(
  { email, phone, amount, plan, mac }: { email?: string; phone?: string; amount: number; plan: string; mac?: string },
): Promise<{ checkoutUrl: string; paymentReference: string }> {
  const base = Deno.env.get("SQUAD_BASE_URL") || "https://api-d.squadco.com";
  const secret = Deno.env.get("SQUAD_SECRET_KEY")!;
  const reference = "SQ" + generatePaymentReference(10);
  const res = await fetch(`${base}/transaction/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      email: contactEmail(email, phone),
      currency: "NGN",
      initiate_type: "inline",
      transaction_ref: reference,
      customer_name: "WiFi Customer",
      callback_url: `${PUBLIC_BASE}/squad-callback`,
      payment_channels: ["card", "bank", "ussd", "transfer"],
      metadata: { mac_address: mac || "unknown", plan, phone: phone || "" },
      pass_charge: false,
    }),
  });
  const data = await res.json();
  return { checkoutUrl: data?.data?.checkout_url, paymentReference: reference };
}

async function initPaystack(
  { email, phone, amount, plan, mac }: { email?: string; phone?: string; amount: number; plan: string; mac?: string },
): Promise<{ checkoutUrl: string; paymentReference: string }> {
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY")!;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      email: contactEmail(email, phone),
      currency: "NGN",
      callback_url: `${PUBLIC_BASE}/paystack-callback`,
      metadata: { mac_address: mac || "unknown", plan, phone: phone || "" },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data?.data?.authorization_url) {
    throw new Error(`paystack init failed: ${data?.message || JSON.stringify(data)}`);
  }
  return { checkoutUrl: data.data.authorization_url, paymentReference: data.data.reference };
}

async function getActiveProvider(): Promise<string> {
  const fallback = (Deno.env.get("PAYMENT_PROVIDER") || "squad").toLowerCase();
  try {
    const { data } = await getSupabase()
      .from("app_settings").select("value").eq("key", "payment_provider").maybeSingle();
    if (data?.value) return String(data.value).toLowerCase();
  } catch (_) { /* ignore */ }
  return fallback;
}

async function initPayment(args: { email?: string; phone?: string; amount: number; plan: string; mac?: string }) {
  const provider = await getActiveProvider();
  return provider === "paystack" ? await initPaystack(args) : await initSquad(args);
}

// ---------- queue insertion ----------
async function enqueue(
  { ref, email, phone, planCode, mac, provider = "Squad" }: { ref: string; email?: string; phone?: string; planCode: string; mac?: string; provider?: string },
): Promise<void> {
  const supabase = getSupabase();
  const username = `dht${Date.now().toString().slice(-5)}`;
  const password = generatePassword();
  const token = oneTimeToken();
  const expiresAt = expiryFromPlan(planCode);
  await supabase.from("payment_queue").insert({
    transaction_id: ref,
    customer_email: email || "unknown@example.com",
    customer_phone: phone || "",
    plan: planCode,
    mikrotik_username: username,
    mikrotik_password: password,
    mac_address: mac || "unknown",
    status: "pending",
    expires_at: expiresAt.toISOString(),
    one_time_token: token,
  });
  console.log(`🙋 Queued ${username} | ${planCode} | MAC:${mac} | Ref:${ref}`);
  await logActivity("queue", `🙋 [${provider}] Queued ${username} | Plan: ${planCode} | MAC: ${mac} | Ref: ${ref}`, { ref, username, mac, level: "queue" });
}

function resolvePlan(raw?: string): { planCode: string; amount: number } | null {
  if (!raw) return null;
  if (planConfig[raw]) return { planCode: planConfig[raw].code, amount: planConfig[raw].amount };
  if (Object.values(planConfig).some((p) => p.code === raw)) {
    const p = Object.values(planConfig).find((x) => x.code === raw)!;
    return { planCode: p.code, amount: p.amount };
  }
  return null;
}

// ---------- route handlers ----------
function checkApiKey(req: Request): boolean {
  const key = req.headers.get("x-api-key") || queryParams(req).get("api_key");
  const expected = Deno.env.get("MIKROTIK_API_KEY") || "";
  return !!expected && key === expected;
}

async function mikrotikQueueText(): Promise<Response> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("payment_queue")
    .select("id, mikrotik_username, mikrotik_password, plan, mac_address, expires_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error || !data || data.length === 0) return text("");
  const lines = data.map((r) => [
    r.mikrotik_username || "",
    r.mikrotik_password || "",
    r.plan || "",
    "00:00:00:00:00:00",
    r.expires_at ? new Date(r.expires_at).toISOString() : "",
    r.id,
  ].join("|"));
  await logActivity("mikrotik", `✒️ Preparing ${data.length} users for MikroTik`, { level: "mikrotik" });
  return text(lines.join("\n"));
}

async function markProcessed(idRaw: string): Promise<Response> {
  const id = parseInt((idRaw || "").split("|").pop() || "", 10);
  if (isNaN(id)) return json({ success: false, error: "Invalid ID" }, 400);
  await logActivity("mikrotik", `⌛ Processing mark-processed for: ${id}`, { level: "mikrotik" });
  const { data, error } = await getSupabase()
    .from("payment_queue")
    .update({ status: "processed", processed_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return json({ success: false, error: error.message }, 500);
  if (!data || data.length === 0) return json({ success: false, error: "User not found" }, 404);
  await logActivity("mikrotik", `✅ Successfully marked ${id} as processed`, { level: "mikrotik" });
  return json({ success: true, id });
}

async function expiredUsers(): Promise<Response> {
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("id, mikrotik_username, mac_address, expires_at")
    .eq("status", "processed")
    .not("expires_at", "is", null)
    .lt("expires_at", new Date().toISOString())
    .limit(20);
  if (!data || data.length === 0) return text("");
  const lines = data.map((r) => [
    r.mikrotik_username || "unknown",
    "00:00:00:00:00:00",
    r.expires_at ? new Date(r.expires_at).toISOString() : "",
    r.id,
  ].join("|"));
  return text(lines.join("\n"));
}

async function markExpired(idRaw: string): Promise<Response> {
  const id = parseInt((idRaw || "").split("|").pop() || "", 10);
  if (isNaN(id) || id <= 0) return json({ success: false });
  const { data } = await getSupabase()
    .from("payment_queue")
    .update({ status: "expired" })
    .eq("id", id)
    .eq("status", "processed")
    .select("mikrotik_username");
  if (data && data.length > 0) {
    await logActivity("mikrotik", `Marked ${id} as expired`, { level: "expired" });
    return json({ success: true, id });
  }
  return json({ success: false });
}

async function checkStatus(ref: string): Promise<Response> {
  if (!ref) return json({ ready: false, message: "No reference provided" });
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("mikrotik_username, mikrotik_password, plan, status, mac_address, expires_at")
    .eq("transaction_id", ref)
    .maybeSingle();
  if (!data) return json({ ready: false, message: "Payment not found. Please wait..." });
  if (data.status === "processed") {
    return json({
      ready: true,
      username: data.mikrotik_username,
      password: data.mikrotik_password,
      plan: data.plan,
      expires_at: data.expires_at,
      message: "Credentials ready",
    });
  }
  return json({ ready: false, status: data.status, expires_at: data.expires_at, message: `Status: ${data.status} - Please wait...` });
}

async function getToken(ref: string): Promise<Response> {
  if (!ref) return json({ error: "No reference provided" }, 400);
  const { data } = await getSupabase()
    .from("payment_queue").select("one_time_token").eq("transaction_id", ref).maybeSingle();
  return json({ token: data?.one_time_token ?? null });
}

async function checkToken(req: Request): Promise<Response> {
  const token = req.headers.get("x-auth-token") || queryParams(req).get("token");
  if (!token) return json({ found: false });
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("mikrotik_username, mikrotik_password, plan, status, expires_at")
    .eq("one_time_token", token)
    .eq("status", "processed")
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  const row = data?.[0];
  if (!row) return json({ found: false });
  return json({
    found: true,
    username: row.mikrotik_username,
    password: row.mikrotik_password,
    plan: row.plan,
    expires_at: row.expires_at,
  });
}

async function checkMac(macRaw: string): Promise<Response> {
  const mac = (macRaw || "").trim().toUpperCase();
  if (!mac || mac === "UNKNOWN" || mac.length < 10) return json({ found: false });
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("mikrotik_username, mikrotik_password, plan, status, expires_at, transaction_id")
    .eq("mac_address", mac)
    .in("status", ["pending", "processed"])
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return json({ found: false });
  if (row.status === "pending") {
    return json({ found: true, ready: false, message: "Account is being created, please wait..." });
  }
  return json({
    found: true,
    ready: true,
    username: row.mikrotik_username,
    password: row.mikrotik_password,
    plan: row.plan,
    expires: row.expires_at,
    reference: row.transaction_id,
  });
}

async function checkEmail(email: string): Promise<Response> {
  if (!email) return json({ error: "Email required" }, 400);
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("mikrotik_username, mikrotik_password, plan, expires_at, one_time_token")
    .eq("customer_email", email)
    .eq("status", "processed")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return json({ found: false, message: "No active account for this email." });
  return json({
    found: true,
    username: row.mikrotik_username,
    password: row.mikrotik_password,
    plan: row.plan,
    expires_at: row.expires_at,
    token: row.one_time_token,
  });
}

async function checkPhone(phoneRaw: string): Promise<Response> {
  const phone = (phoneRaw || "").replace(/[^0-9]/g, "");
  if (!phone) return json({ error: "Phone required" }, 400);
  const { data } = await getSupabase()
    .from("payment_queue")
    .select("mikrotik_username, mikrotik_password, plan, expires_at, one_time_token")
    .eq("customer_phone", phone)
    .eq("status", "processed")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return json({ found: false, message: "No active account for this phone number." });
  return json({
    found: true,
    username: row.mikrotik_username,
    password: row.mikrotik_password,
    plan: row.plan,
    expires_at: row.expires_at,
    token: row.one_time_token,
  });
}

// ---------- success page ----------
function successPage(ref: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Payment Successful</title>
<style>
body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff;margin:0;padding:20px}
.c{background:rgba(255,255,255,.05);padding:30px;border-radius:20px;max-width:420px;width:100%;text-align:center;border:1px solid rgba(255,255,255,.1)}
.cred{background:rgba(255,255,255,.9);color:#000;padding:12px;border-radius:8px;margin:8px 0;font-family:monospace;font-size:18px;font-weight:bold;cursor:pointer}
.lbl{font-size:12px;color:#bbb;text-align:left}
.b{background:linear-gradient(135deg,#00c9ff,#92fe9d);color:#000;border:none;padding:14px 28px;border-radius:50px;font-weight:bold;cursor:pointer;margin-top:12px}
.sp{width:40px;height:40px;border:3px solid rgba(255,255,255,.1);border-top:3px solid #00c9ff;border-radius:50%;animation:s 1s linear infinite;margin:15px auto}
@keyframes s{to{transform:rotate(360deg)}}
.h{display:none}
</style></head><body><div class="c">
<div style="font-size:40px">🌐</div><h2 id="t">Creating your WiFi account...</h2>
<div class="sp" id="sp"></div>
<div id="loading"><p id="msg">Please wait...</p><p style="font-size:12px;color:#888">Ref: ${ref}</p></div>
<div id="creds" class="h">
<p>✅ Payment received</p>
<div class="lbl">Username</div><div class="cred" id="u">---</div>
<div class="lbl">Password</div><div class="cred" id="p">---</div>
<div class="lbl">Plan</div><div class="cred" id="pl">---</div>
<div class="lbl">Expires</div><div class="cred" id="ex">---</div>
<button class="b" onclick="go()">🚀 Auto-Login</button>
</div>
<div id="err" class="h"><p>Still processing. <button class="b" onclick="poll()">Check again</button></p></div>
</div>
<script>
const API='${PUBLIC_BASE}';const ref='${ref}';let c=0,creds={};
async function poll(){
  c++;
  try{
    const r=await fetch(API+'/api/check-status?ref='+encodeURIComponent(ref));
    const d=await r.json();
    if(d.ready){creds=d;document.getElementById('u').textContent=d.username;document.getElementById('p').textContent=d.password;
      document.getElementById('pl').textContent=d.plan;document.getElementById('ex').textContent=d.expires_at?new Date(d.expires_at).toLocaleString():'';
      document.getElementById('loading').className='h';document.getElementById('creds').className='h';document.getElementById('t').textContent='Your credentials';
      document.getElementById('sp').style.display='none';
      setTimeout(go,4000);return;}
  }catch(e){}
  if(c>=20){document.getElementById('err').className='h';document.getElementById('err').classList.remove('h');document.getElementById('loading').className='h';return;}
  document.getElementById('msg').textContent=d?.message||'Waiting for your account...';
  setTimeout(poll,5000);
}
function go(){location.href='http://192.168.88.1/login?username='+encodeURIComponent(creds.username||'')+'&password='+encodeURIComponent(creds.password||'')+'&auto=1';}
setTimeout(poll,3000);
</script></body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:50px;background:#1a1a2e;color:#fff"><h2>⚠️ ${message}</h2><a href="javascript:history.back()" style="color:#00d4ff">← Go Back</a></body></html>`;
}

// ---------- main ----------
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const path = routePath(req);
  const method = req.method;
  console.log(`${method} ${path}`);

  try {
    // ---- admin API ----
    if (path.startsWith("/admin/api/")) return await handleAdmin(req, path);

    // ---- router-facing (x-api-key) ----
    if (path === "/api/mikrotik-queue-text" && method === "GET") {
      if (!checkApiKey(req)) return text("FORBIDDEN", 403);
      return await mikrotikQueueText();
    }
    if (path.startsWith("/api/mark-processed/") && method === "POST") {
      if (!checkApiKey(req)) return text("FORBIDDEN", 403);
      return await markProcessed(path.substring("/api/mark-processed/".length));
    }
    if (path === "/api/expired-users" && method === "GET") {
      if (!checkApiKey(req)) return text("", 403);
      return await expiredUsers();
    }
    if (path.startsWith("/api/mark-expired/") && method === "POST") {
      if (!checkApiKey(req)) return text("FORBIDDEN", 403);
      return await markExpired(path.substring("/api/mark-expired/".length));
    }

    // ---- payment init ----
    if (path.startsWith("/pay/") && method === "GET") {
      const plan = path.substring("/pay/".length);
      const selected = planConfig[plan];
      const q = queryParams(req);
      const mac = q.get("mac") || "unknown";
      const email = q.get("email") || undefined;
      const phone = q.get("phone") || undefined;
      if (!selected) return html(errorPage("Invalid plan selected"), 400);
      if (!email && !phone) return html(errorPage("Email address or phone number is required to complete purchase."), 400);
      try {
        const { checkoutUrl, paymentReference } = await initPayment({ email, phone, amount: selected.amount, plan: selected.code, mac });
        await logActivity("pay", `💵 Payment [${await getActiveProvider()}]: ${plan} | MAC: ${mac} | ${email ? ("Email: " + email) : ("Phone: " + phone)} | Ref: ${paymentReference}`, { ref: paymentReference, mac, level: "payment" });
        return new Response(null, { status: 302, headers: { Location: checkoutUrl } });
      } catch (e) {
        console.error("payment init error", e);
        return html(errorPage("Could not initialize payment. Please try again."), 500);
      }
    }

    if (path === "/api/initialize-payment" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { email, phone, amount, plan, mac_address } = body as Record<string, unknown>;
      if (!amount || !plan) return json({ error: "Missing amount or plan" }, 400);
      try {
        const { checkoutUrl, paymentReference } = await initPayment({
          email: email as string,
          phone: phone as string,
          amount: Number(amount),
          plan: String(plan),
          mac: mac_address as string,
        });
        await logActivity("pay", `💵 Payment [${await getActiveProvider()}]: ${plan} | MAC: ${mac_address} | ${email ? ("Email: " + email) : ("Phone: " + phone)} | Ref: ${paymentReference}`, { ref: paymentReference, mac: String(mac_address || ""), level: "payment" });
        return json({ success: true, checkout_url: checkoutUrl, payment_reference: paymentReference });
      } catch (e) {
        console.error("initialize error", e);
        return json({ error: "Failed to initialize payment" }, 500);
      }
    }

    // ---- webhooks ----
    if (path === "/api/squad-webhook" && method === "POST") {
      const raw = await rawBody(req);
      const secret = Deno.env.get("SQUAD_SECRET_KEY") || "";
      const received = (req.headers.get("x-squad-encrypted-body") || "").toUpperCase();
      const computed = (await hmacHex(secret, raw)).toUpperCase();
      if (!received || computed !== received) {
        console.log("❌ invalid squad signature");
        return new Response("Invalid signature", { status: 400 });
      }
      try {
        const body = JSON.parse(raw);
        const { Event, Body } = body || {};
        if (Event !== "charge_successful" || !Body || Body.transaction_status !== "Success") {
          return json({ received: true });
        }
        const ref = Body.transaction_ref;
        const meta = Body.meta || {};
        const mac = meta.mac_address || "unknown";
        const amountNaira = Number(Body.amount) / 100;
        const planCode = meta.plan || amountToPlan[amountNaira];
        if (!planCode) return json({ error: "Invalid amount" }, 400);
        const ex = await getSupabase().from("payment_queue").select("id").eq("transaction_id", ref).limit(1);
        if (ex.data && ex.data.length > 0) return json({ received: true });
        await enqueue({ ref, email: Body.email, phone: meta.phone || "", planCode, mac, provider: "Squad" });
        return json({ received: true });
      } catch (e) {
        console.error("squad webhook error", e);
        return json({ error: "Webhook processing failed" }, 500);
      }
    }

    if (path === "/api/paystack-webhook" && method === "POST") {
      const raw = await rawBody(req);
      const secret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
      const received = req.headers.get("x-paystack-signature") || "";
      const computed = await hmacHex(secret, raw);
      if (!received || computed !== received) {
        console.log("❌ invalid paystack signature");
        return new Response("Invalid signature", { status: 400 });
      }
      try {
        const body = JSON.parse(raw);
        if (body.event !== "charge.success") return json({ received: true });
        const d = body.data || {};
        const ref = d.reference;
        const meta = d.metadata || {};
        const mac = meta.mac_address || "unknown";
        const amountNaira = Number(d.amount) / 100;
        const planCode = meta.plan || amountToPlan[amountNaira];
        if (!planCode) return json({ error: "Invalid amount" }, 400);
        const ex = await getSupabase().from("payment_queue").select("id").eq("transaction_id", ref).limit(1);
        if (ex.data && ex.data.length > 0) return json({ received: true });
        await enqueue({ ref, email: d.customer?.email, phone: meta.phone || d.customer?.phone || "", planCode, mac, provider: "Paystack" });
        return json({ received: true });
      } catch (e) {
        console.error("paystack webhook error", e);
        return json({ error: "Webhook processing failed" }, 500);
      }
    }

    if (path === "/squad-callback" && method === "GET") {
      const ref = queryParams(req).get("transaction_ref") || queryParams(req).get("reference") || "";
      await logActivity("callback", `🔗 Squad callback: ${ref}`, { ref, level: "callback" });
      return new Response(null, { status: 302, headers: { Location: `${SUCCESS_PAGE}?reference=${encodeURIComponent(ref)}` } });
    }
    if (path === "/paystack-callback" && method === "GET") {
      const ref = queryParams(req).get("reference") || queryParams(req).get("trxref") || "";
      await logActivity("callback", `🔗 Paystack callback: ${ref}`, { ref, level: "callback" });
      return new Response(null, { status: 302, headers: { Location: `${SUCCESS_PAGE}?reference=${encodeURIComponent(ref)}` } });
    }

    // ---- status / creds ----
    if (path === "/success" && method === "GET") {
      const ref = queryParams(req).get("reference") || queryParams(req).get("trxref") || queryParams(req).get("paymentReference") || "";
      await logActivity("success", `💱 Success page accessed, ref: ${ref}`, { ref, level: "success" });
      return html(successPage(ref));
    }
    if (path === "/api/check-status" && method === "GET") return await checkStatus(queryParams(req).get("ref") || "");
    if (path === "/api/get-token" && method === "GET") return await getToken(queryParams(req).get("ref") || "");
    if (path === "/api/check-token" && method === "GET") return await checkToken(req);
    if (path === "/api/check-email" && method === "GET") return await checkEmail(queryParams(req).get("email") || "");
    if (path === "/api/check-phone" && method === "GET") return await checkPhone(queryParams(req).get("phone") || "");
    if (path === "/api/check-mac" && method === "GET") return await checkMac(queryParams(req).get("mac") || "");

    if (path === "/health" && method === "GET") {
      const provider = await getActiveProvider();
      const { count } = await getSupabase().from("payment_queue").select("*", { count: "exact", head: true });
      return json({ status: "OK", timestamp: new Date().toISOString(), total_payments: count ?? 0, payment_provider: provider });
    }

    // ---- portal ----
    if (path === "/" && method === "GET") {
      const cards = Object.entries(planConfig).map(([slug, p]) =>
        `<div class="card"><b>${p.label}</b> — ₦${p.amount}<br><small>${p.duration}</small><br><a class="b" href="/pay/${slug}?email=CUSTOMER_EMAIL&mac=DEVICE_MAC">Buy</a></div>`
      ).join("");
      return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WiFi Portal</title>
<style>body{font-family:Arial;background:#0c1127;color:#fff;text-align:center;padding:30px;margin:0}
.card{background:rgba(255,255,255,.06);padding:18px;border-radius:14px;margin:12px auto;max-width:360px}
.b{background:linear-gradient(135deg,#00c9ff,#92fe9d);color:#000;padding:10px 22px;border-radius:50px;text-decoration:none;font-weight:bold;display:inline-block;margin-top:8px}</style></head>
<body><h1>🌐 WiFi Access</h1><p>Choose a plan to get online</p>${cards}
<p style="margin-top:20px;font-size:12px;color:#888">Already paid? <a href="/success" style="color:#00c9ff">Check status</a></p></body></html>`);
    }

    return json({ error: "Not found", path }, 404);
  } catch (err) {
    console.error("UNHANDLED", err);
    return json({ error: "Internal server error", details: String(err) }, 500);
  }
});
