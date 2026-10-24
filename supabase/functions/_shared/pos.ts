// POS client state, persisted in Supabase Storage so no schema migration is required.
// The router posts the currently-visible POS clients (ARP/DHCP) every minute.

const BUCKET = "pos-state";
const FILE = "clients.json";
const CONNECTED_TTL_MS = 5 * 60 * 1000;

export type PosClient = {
  mac: string;
  ip: string;
  hostname: string;
  first_seen: string;
  last_seen: string;
  connected: boolean;
  last_connected: string | null;
  last_disconnected: string | null;
};

type PosState = {
  clients: Record<string, PosClient>;
  updated_at: string | null;
};

function normMac(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/-/g, ":");
}

function ts(value: string | null | undefined): number {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function ensureBucket(sb: any): Promise<void> {
  const { data } = await sb.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message || "")) {
    throw new Error(`POS storage bucket: ${error.message}`);
  }
}

export async function readPosState(sb: any): Promise<PosState> {
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(FILE);
    if (error || !data) return { clients: {}, updated_at: null };
    const parsed = JSON.parse(await data.text());
    return {
      clients: parsed && typeof parsed.clients === "object" && parsed.clients ? parsed.clients : {},
      updated_at: parsed?.updated_at ?? null,
    };
  } catch (_error) {
    return { clients: {}, updated_at: null };
  }
}

async function writePosState(sb: any, state: PosState): Promise<void> {
  await ensureBucket(sb);
  const body = new Blob([JSON.stringify(state)], { type: "application/json" });
  const { error } = await sb.storage.from(BUCKET).upload(FILE, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`POS storage write: ${error.message}`);
}

export async function syncPosClients(sb: any, incoming: any[]): Promise<{
  received: number;
  connected: number;
  total: number;
  newly_connected: number;
  newly_disconnected: number;
}> {
  const state = await readPosState(sb);
  const now = new Date().toISOString();
  const seen = new Set<string>();
  let newlyConnected = 0;

  for (const raw of incoming) {
    const mac = normMac(raw?.mac);
    if (!mac || mac === "00:00:00:00:00:00") continue;
    const ip = String(raw?.ip ?? "").trim();
    const hostname = String(raw?.hostname ?? "").trim();
    seen.add(mac);
    const prev = state.clients[mac];
    if (!prev) newlyConnected++;
    else if (!prev.connected) newlyConnected++;
    state.clients[mac] = {
      mac,
      ip: ip || prev?.ip || "",
      hostname: hostname || prev?.hostname || "",
      first_seen: prev?.first_seen || now,
      last_seen: now,
      connected: true,
      last_connected: prev?.connected ? (prev.last_connected || now) : now,
      last_disconnected: prev?.last_disconnected || null,
    };
  }

  let newlyDisconnected = 0;
  for (const [mac, client] of Object.entries(state.clients)) {
    if (!seen.has(mac) && client.connected) {
      client.connected = false;
      client.last_disconnected = now;
      newlyDisconnected++;
    }
  }

  state.updated_at = now;
  await writePosState(sb, state);

  const connected = Object.values(state.clients).filter((c) =>
    c.connected && Date.now() - ts(c.last_seen) < CONNECTED_TTL_MS
  ).length;

  return {
    received: incoming.length,
    connected,
    total: Object.keys(state.clients).length,
    newly_connected: newlyConnected,
    newly_disconnected: newlyDisconnected,
  };
}

export async function purgePosClient(sb: any, macRaw: string): Promise<boolean> {
  const mac = normMac(macRaw);
  if (!mac) return false;
  const state = await readPosState(sb);
  if (!state.clients[mac]) return false;
  delete state.clients[mac];
  state.updated_at = new Date().toISOString();
  await writePosState(sb, state);
  return true;
}

export async function getPosStats(sb: any): Promise<{
  connected: number;
  total: number;
  week: number;
  month: number;
  updated_at: string | null;
  clients: Array<{
    mac: string;
    ip: string;
    hostname: string;
    first_seen: string;
    last_seen: string;
    connected: boolean;
  }>;
}> {
  const state = await readPosState(sb);
  const now = Date.now();
  const clients = Object.values(state.clients);
  const live = clients.filter((c) => c.connected && now - ts(c.last_seen) < CONNECTED_TTL_MS);
  const weekStart = now - 7 * 86400000;
  const monthStart = now - 30 * 86400000;

  return {
    connected: live.length,
    total: clients.length,
    week: clients.filter((c) => ts(c.last_seen) >= weekStart).length,
    month: clients.filter((c) => ts(c.last_seen) >= monthStart).length,
    updated_at: state.updated_at,
    clients: live
      .map((c) => ({
        mac: c.mac,
        ip: c.ip,
        hostname: c.hostname,
        first_seen: c.first_seen,
        last_seen: c.last_seen,
        connected: true,
      }))
      .sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}
