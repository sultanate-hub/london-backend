// POS client state, persisted in Supabase Storage so no schema migration is required.
// The router posts the currently-visible POS clients (ARP/DHCP) every minute.

const BUCKET = "pos-state";
const FILE = "clients.json";
// Blocks live in their own object so the 60 s client sync can never overwrite a
// block that a superadmin added while the sync was running.
const BLOCKS_FILE = "blocks.json";
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

export type PosBlock = {
  mac: string;
  reason: string;
  blocked_at: string;
  blocked_by: string;
};

type PosState = {
  clients: Record<string, PosClient>;
  blocks: Record<string, PosBlock>;
  updated_at: string | null;
};

export function normMac(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/-/g, ":");
}

export function isValidMac(value: string): boolean {
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
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
  const state: PosState = { clients: {}, blocks: {}, updated_at: null };
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(FILE);
    if (!error && data) {
      const parsed = JSON.parse(await data.text());
      state.clients = parsed && typeof parsed.clients === "object" && parsed.clients ? parsed.clients : {};
      state.updated_at = parsed?.updated_at ?? null;
    }
  } catch (_error) { /* a missing/corrupt client file is an empty history */ }
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(BLOCKS_FILE);
    if (!error && data) {
      const parsed = JSON.parse(await data.text());
      const rawBlocks = parsed?.blocks;
      if (rawBlocks && typeof rawBlocks === "object") {
        for (const [key, raw] of Object.entries(rawBlocks)) {
          const value = raw as Partial<PosBlock>;
          const mac = normMac(value?.mac || key);
          if (!isValidMac(mac)) continue;
          state.blocks[mac] = {
            mac,
            reason: String(value?.reason ?? ""),
            blocked_at: String(value?.blocked_at ?? ""),
            blocked_by: String(value?.blocked_by ?? ""),
          };
        }
      }
    }
  } catch (_error) { /* a missing/corrupt block file means no blocks */ }
  return state;
}

async function writePosState(sb: any, state: PosState): Promise<void> {
  await ensureBucket(sb);
  const body = new Blob([JSON.stringify({ clients: state.clients, updated_at: state.updated_at })], {
    type: "application/json",
  });
  const { error } = await sb.storage.from(BUCKET).upload(FILE, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`POS storage write: ${error.message}`);
}

async function writePosBlocks(sb: any, blocks: Record<string, PosBlock>, updatedAt: string): Promise<void> {
  await ensureBucket(sb);
  const body = new Blob([JSON.stringify({ blocks, updated_at: updatedAt })], { type: "application/json" });
  const { error } = await sb.storage.from(BUCKET).upload(BLOCKS_FILE, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`POS block storage write: ${error.message}`);
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
    c.connected && Date.now() - ts(c.last_seen) < CONNECTED_TTL_MS && !state.blocks[c.mac]
  ).length;

  return {
    received: incoming.length,
    connected,
    total: Object.keys(state.clients).length,
    newly_connected: newlyConnected,
    newly_disconnected: newlyDisconnected,
  };
}

export async function resetPosState(sb: any): Promise<{ removed: number }> {
  const state = await readPosState(sb);
  const removed = Object.keys(state.clients).length;
  // Blocks are policy, not history. Keep them when the counter is reset.
  await writePosState(sb, { clients: {}, blocks: state.blocks, updated_at: new Date().toISOString() });
  return { removed };
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

export async function blockPosClient(
  sb: any,
  macRaw: string,
  reason: string,
  actor: string,
): Promise<PosBlock> {
  const mac = normMac(macRaw);
  if (!isValidMac(mac)) throw new Error("Invalid MAC address");
  const state = await readPosState(sb);
  const now = new Date().toISOString();
  const block: PosBlock = {
    mac,
    reason: String(reason ?? "").trim().slice(0, 200),
    blocked_at: now,
    blocked_by: String(actor || "superadmin"),
  };
  state.blocks[mac] = block;
  await writePosBlocks(sb, state.blocks, now);
  return block;
}

export async function unblockPosClient(sb: any, macRaw: string): Promise<boolean> {
  const mac = normMac(macRaw);
  if (!isValidMac(mac)) throw new Error("Invalid MAC address");
  const state = await readPosState(sb);
  if (!state.blocks[mac]) return false;
  delete state.blocks[mac];
  await writePosBlocks(sb, state.blocks, new Date().toISOString());
  return true;
}

export async function getPosBlocks(sb: any): Promise<{
  count: number;
  updated_at: string | null;
  blocks: Array<{ mac: string; reason: string; blocked_at: string }>;
}> {
  const state = await readPosState(sb);
  return {
    count: Object.keys(state.blocks).length,
    updated_at: state.updated_at,
    blocks: Object.values(state.blocks)
      .map((b) => ({ mac: b.mac, reason: b.reason, blocked_at: b.blocked_at }))
      .sort((a, b) => a.mac.localeCompare(b.mac)),
  };
}

export async function getPosStats(sb: any): Promise<{
  connected: number;
  total: number;
  week: number;
  month: number;
  blocked_count: number;
  updated_at: string | null;
  clients: Array<{
    mac: string;
    ip: string;
    hostname: string;
    first_seen: string;
    last_seen: string;
    connected: boolean;
  }>;
  blocked: Array<{
    mac: string;
    reason: string;
    blocked_at: string;
    blocked_by: string;
    ip: string;
    hostname: string;
    last_seen: string | null;
  }>;
}> {
  const state = await readPosState(sb);
  const now = Date.now();
  const clients = Object.values(state.clients);
  const live = clients.filter((c) =>
    c.connected && now - ts(c.last_seen) < CONNECTED_TTL_MS && !state.blocks[c.mac]
  );
  const weekStart = now - 7 * 86400000;
  const monthStart = now - 30 * 86400000;

  return {
    connected: live.length,
    total: clients.length,
    week: clients.filter((c) => ts(c.last_seen) >= weekStart).length,
    month: clients.filter((c) => ts(c.last_seen) >= monthStart).length,
    blocked_count: Object.keys(state.blocks).length,
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
    blocked: Object.values(state.blocks)
      .map((b) => {
        const c = state.clients[b.mac];
        return {
          mac: b.mac,
          reason: b.reason,
          blocked_at: b.blocked_at,
          blocked_by: b.blocked_by,
          ip: c?.ip || "",
          hostname: c?.hostname || "",
          last_seen: c?.last_seen || null,
        };
      })
      .sort((a, b) => a.mac.localeCompare(b.mac)),
  };
}
