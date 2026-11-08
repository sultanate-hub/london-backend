import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  blockPosClient,
  getPosBlocks,
  getPosStats,
  resetPosState,
  syncPosClients,
  unblockPosClient,
} from "./pos.ts";

// Minimal in-memory stand-in for the Supabase Storage API used by pos.ts.
function fakeSupabase() {
  const files = new Map<string, string>();
  const bucket = {
    download: async (name: string) => {
      const text = files.get(name);
      if (text === undefined) return { data: null, error: { message: "not found" } };
      return { data: { text: async () => text }, error: null };
    },
    upload: async (name: string, body: Blob) => {
      files.set(name, await body.text());
      return { error: null };
    },
  };
  return {
    storage: {
      getBucket: async () => ({ data: { name: "pos-state" } }),
      createBucket: async () => ({ error: null }),
      from: () => bucket,
    },
  };
}

const MAC_1 = "AA:BB:CC:DD:EE:01";
const MAC_2 = "AA:BB:CC:DD:EE:02";

Deno.test("POS block hides a live client and unblock restores it", async () => {
  const sb = fakeSupabase();
  await syncPosClients(sb, [
    { mac: MAC_1, ip: "192.168.20.10", hostname: "POS-1" },
    { mac: MAC_2, ip: "192.168.20.11", hostname: "POS-2" },
  ]);

  let stats = await getPosStats(sb);
  assertEquals(stats.connected, 2);
  assertEquals(stats.blocked_count, 0);

  const block = await blockPosClient(sb, MAC_1, "not a POS device", "superadmin");
  assertEquals(block.mac, MAC_1);

  stats = await getPosStats(sb);
  assertEquals(stats.connected, 1);
  assertEquals(stats.blocked_count, 1);
  assertEquals(stats.clients.map((c) => c.mac), [MAC_2]);
  assertEquals(stats.blocked.map((b) => b.mac), [MAC_1]);

  const blocks = await getPosBlocks(sb);
  assertEquals(blocks.count, 1);
  assertEquals(blocks.blocks[0].mac, MAC_1);

  assertEquals(await unblockPosClient(sb, MAC_1), true);
  stats = await getPosStats(sb);
  assertEquals(stats.connected, 2);
  assertEquals(stats.blocked_count, 0);
});

Deno.test("POS counter reset keeps the block policy", async () => {
  const sb = fakeSupabase();
  await syncPosClients(sb, [{ mac: MAC_1, ip: "192.168.20.10", hostname: "POS-1" }]);
  await blockPosClient(sb, MAC_1, "blocked", "superadmin");

  const reset = await resetPosState(sb);
  assertEquals(reset.removed, 1);
  assertEquals((await getPosBlocks(sb)).count, 1);
});

Deno.test("POS sync ignores clients outside the POS VLAN", async () => {
  const sb = fakeSupabase();
  const result = await syncPosClients(sb, [
    { mac: "AA:BB:CC:DD:EE:03", ip: "192.168.88.50", hostname: "guest-laptop" },
    { mac: "AA:BB:CC:DD:EE:04", ip: "10.0.0.5", hostname: "main-lan" },
    { mac: "01:BB:CC:DD:EE:05", ip: "192.168.20.12", hostname: "multicast" },
  ]);
  assertEquals(result.received, 3);
  const stats = await getPosStats(sb);
  assertEquals(stats.total, 0);
  assertEquals(stats.connected, 0);
  assertEquals(stats.clients.length, 0);
});

Deno.test("block rejects an invalid MAC", async () => {
  const sb = fakeSupabase();
  let failed = false;
  try {
    await blockPosClient(sb, "not-a-mac", "test", "superadmin");
  } catch (_error) {
    failed = true;
  }
  assertEquals(failed, true);
});
