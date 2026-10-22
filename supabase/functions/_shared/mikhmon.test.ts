import { assertEquals, assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  mapMikhmonPlan,
  parseMikhmonExpiry,
  routerSeconds,
  syncMikhmonUsers,
  toMikhmonRow,
} from "./mikhmon.ts";

Deno.test("mapMikhmonPlan maps every Mikhmon voucher profile", () => {
  assertEquals(mapMikhmonPlan("24hrs"), "24hr");
  assertEquals(mapMikhmonPlan("3-Days"), "3d");
  assertEquals(mapMikhmonPlan("5-Days"), "5d");
  assertEquals(mapMikhmonPlan("7-Days"), "7d");
  assertEquals(mapMikhmonPlan("14-Days"), "14d");
  assertEquals(mapMikhmonPlan("30-Days"), "30d");
  assertEquals(mapMikhmonPlan("daily"), "24hr");
  assertEquals(mapMikhmonPlan("6-Hours"), "6h");
  assertEquals(mapMikhmonPlan("default"), "default");
  assertEquals(mapMikhmonPlan("something-new"), "other");
});

Deno.test("parseMikhmonExpiry handles timestamps and refuses voucher codes", () => {
  assertEquals(parseMikhmonExpiry("2026-10-22 18:22:00"), "2026-10-22T17:22:00.000Z");
  assertEquals(parseMikhmonExpiry("2026-10-22T18:22:00"), "2026-10-22T17:22:00.000Z");
  assertEquals(parseMikhmonExpiry("vc-137-10.22.26-4GBProfile"), null);
  assertEquals(parseMikhmonExpiry(""), null);
  assertEquals(parseMikhmonExpiry("2026-13-40 99:99:99"), null);
});

Deno.test("toMikhmonRow builds a safe, priced row", () => {
  const row = toMikhmonRow({
    name: "ALMv3hkc",
    password: "ALMv3hkc",
    profile: "24hrs",
    "mac-address": "aa:bb:cc:dd:ee:ff",
    comment: "2026-10-22 18:22:00",
  })!;
  assertEquals(row.transaction_id, "mikhmon-ALMv3hkc");
  assertEquals(row.customer_email, "Mikhmon (24hr)");
  assertEquals(row.customer_phone, "Mikhmon");
  assertEquals(row.plan, "24hr");
  assertEquals(row.mikrotik_password, "ALMv3hkc");
  assertEquals(row.mac_address, "AA:BB:CC:DD:EE:FF");
  assertEquals(row.status, "processed");
  assertEquals(row.expires_at, "2026-10-22T17:22:00.000Z");
});

Deno.test("toMikhmonRow marks disabled/exhausted users expired", () => {
  assertEquals(toMikhmonRow({ name: "u1", disabled: "true" })!.status, "expired");
  assertEquals(toMikhmonRow({ name: "u2", "limit-uptime": "1s" })!.status, "expired");
  assertEquals(toMikhmonRow({ name: "u3" })!.status, "processed");
});

Deno.test("toMikhmonRow rejects empty names and bad MACs", () => {
  assertEquals(toMikhmonRow({ name: "   " }), null);
  assertEquals(toMikhmonRow({ name: "u4", mac: "not-a-mac" })!.mac_address, "");
});

// ---------- fake Supabase (thenable query) ----------
class Query {
  db: FakeDb;
  table: string;
  mode = "select";
  payload: any = null;
  eqs: Array<[string, unknown]> = [];
  likes: Array<[string, unknown]> = [];

  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }
  select() { this.mode = "select"; return this; }
  like(col: string, val: unknown) { this.likes.push([col, val]); return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  update(row: any) { this.mode = "update"; this.payload = row; return this; }
  insert(row: any) { this.mode = "insert"; this.payload = row; return this; }

  then(resolve: (value: any) => void) {
    if (this.mode === "select") {
      resolve({ data: this.db.select(this.table, this.eqs, this.likes), error: null });
    } else if (this.mode === "insert") {
      this.db.insert(this.table, this.payload);
      resolve({ error: null });
    } else {
      this.db.update(this.table, this.payload, this.eqs);
      resolve({ error: null });
    }
  }
}

class FakeDb {
  tables: Record<string, any[]> = { payment_queue: [] };
  ops: Array<{ type: string; row: any }> = [];
  nextId = 1;

  from(table: string) { return new Query(this, table); }

  select(table: string, eqs: Array<[string, unknown]>, likes: Array<[string, unknown]>) {
    return (this.tables[table] ?? [])
      .filter((row) =>
        eqs.every(([col, val]) => {
          if (col === "status") return row.status === val;
          if (col === "id") return row.id === val;
          if (col === "transaction_id") return row.transaction_id === val;
          if (col === "mikrotik_username") return row.mikrotik_username === val;
          return true;
        })
      )
      .filter((row) =>
        likes.every(([col, val]) => {
          if (col === "transaction_id") {
            return String(row.transaction_id ?? "").startsWith(String(val).replace(/%$/, ""));
          }
          return true;
        })
      );
  }
  insert(table: string, row: any) {
    this.ops.push({ type: "insert", row });
    this.tables[table].push({ ...row, id: this.nextId++ });
  }
  update(table: string, row: any, eqs: Array<[string, unknown]>) {
    this.ops.push({ type: "update", row });
    const idFilter = eqs.find(([col]) => col === "id")?.[1];
    for (const existing of this.tables[table]) {
      if (idFilter === undefined || existing.id === idFilter) Object.assign(existing, row);
    }
  }
}

const VOUCHER_COMMENT = "vc-137-10.22.26-4GBProfile";

Deno.test("first-login sync: unused vouchers skipped; active and previously-logged users inserted", async () => {
  const db = new FakeDb();
  const res = await syncMikhmonUsers(db, [
    { name: "unused", password: "unused", profile: "24hrs", comment: VOUCHER_COMMENT },
    { name: "active", password: "active", profile: "24hrs", comment: VOUCHER_COMMENT },
    { name: "logged", password: "logged", profile: "24hrs", comment: "2026-10-22 18:22:00" },
  ], { firstLoginOnly: true, active: ["active"] });

  assertEquals(res.received, 3);
  assertEquals(res.eligible, 2);
  assertEquals(res.skipped, 1);
  assertEquals(res.created, 2);
  assertEquals(res.failed, 0);

  const names = db.tables.payment_queue.map((r) => r.mikrotik_username).sort();
  assertEquals(names, ["active", "logged"]);
  assertEquals(db.tables.payment_queue.every((r) => r.plan === "24hr"), true);
  assertEquals(db.tables.payment_queue.every((r) => r.customer_phone === "Mikhmon"), true);
  assert(db.tables.payment_queue.some((r) => r.customer_email === "Mikhmon (24hr)"));
});

Deno.test("logged-out users stay in the table; nothing is pruned", async () => {
  const db = new FakeDb();
  db.tables.payment_queue.push({
    id: 1,
    transaction_id: "mikhmon-old",
    mikrotik_username: "old",
    mikrotik_password: "old",
    plan: "mikhmon",
    mac_address: "",
    status: "processed",
    expires_at: null,
    customer_email: "Mikhmon (24hr)",
    customer_phone: "Mikhmon",
  });

  await syncMikhmonUsers(db, [
    { name: "active", password: "active", profile: "24hrs", comment: VOUCHER_COMMENT },
  ], { firstLoginOnly: true, active: ["active"] });

  assertEquals(db.tables.payment_queue.some((r) => r.transaction_id === "mikhmon-old"), true);
});

Deno.test("second identical sync changes nothing", async () => {
  const db = new FakeDb();
  const users = [
    { name: "active", password: "active", profile: "24hrs", comment: "2026-10-22 18:22:00" },
  ];
  const first = await syncMikhmonUsers(db, users, { firstLoginOnly: true, active: ["active"] });
  const second = await syncMikhmonUsers(db, users, { firstLoginOnly: true, active: ["active"] });
  assertEquals(first.created, 1);
  assertEquals(second.created, 0);
  assertEquals(second.updated, 0);
  assertEquals(second.unchanged, 1);
});

Deno.test("dry-run writes nothing", async () => {
  const db = new FakeDb();
  const res = await syncMikhmonUsers(db, [
    { name: "active", password: "active", profile: "24hrs", comment: VOUCHER_COMMENT },
  ], { firstLoginOnly: true, active: ["active"], dryRun: true });
  assertEquals(res.eligible, 1);
  assertEquals(res.created, 0);
  assertEquals(db.ops.length, 0);
});

Deno.test("routerSeconds parses RouterOS durations", () => {
  assertEquals(routerSeconds("1d00:00:00"), 86400);
  assertEquals(routerSeconds("00:06:02"), 362);
  assertEquals(routerSeconds("1d"), 86400);
  assertEquals(routerSeconds("1w2d3h"), 788400);
  assertEquals(routerSeconds("1970-01-02 00:00:00"), 86400);
  assertEquals(routerSeconds(86400), 86400);
  assertEquals(routerSeconds("0s"), 0);
  assertEquals(routerSeconds(""), null);
  assertEquals(routerSeconds("junk"), null);
});

Deno.test("first login derives expiry from limit-uptime and never extends it", async () => {
  const db = new FakeDb();
  const user = {
    name: "v",
    password: "v",
    profile: "24hr",
    comment: VOUCHER_COMMENT,
    "limit-uptime": "1d00:00:00",
    uptime: "06:00:00",
  };
  const first = await syncMikhmonUsers(db, [user], { firstLoginOnly: true, active: ["v"] });
  assertEquals(first.created, 1);
  const exp1 = db.tables.payment_queue[0].expires_at as string;
  assert(exp1);
  assert(new Date(exp1).getTime() > Date.now() + 17 * 3600 * 1000);
  assertEquals(first.preview[0].expires_at, exp1);

  const second = await syncMikhmonUsers(db, [{ ...user, uptime: "00:00:01" }], {
    firstLoginOnly: true,
    active: ["v"],
  });
  assertEquals(second.unchanged, 1);
  assertEquals(db.tables.payment_queue[0].expires_at, exp1);
});

Deno.test("6-Hours and default are never shown, even after login", async () => {
  const db = new FakeDb();
  const res = await syncMikhmonUsers(db, [
    { name: "six", password: "six", profile: "6-Hours", comment: "2026-10-22 18:22:00" },
    { name: "def", password: "def", profile: "default", comment: "2026-10-22 18:22:00" },
    { name: "day", password: "day", profile: "24hr", comment: "2026-10-22 18:22:00" },
  ], { firstLoginOnly: true, active: ["six", "def", "day"] });

  assertEquals(res.eligible, 1);
  assertEquals(res.skipped, 2);
  assertEquals(res.created, 1);
  assertEquals(res.names, ["day"]);
  assertEquals(db.tables.payment_queue.map((r) => r.mikrotik_username), ["day"]);
});

Deno.test("backfills expiry for an existing row from first-seen plus plan duration", async () => {
  const db = new FakeDb();
  db.tables.payment_queue.push({
    id: 1,
    transaction_id: "mikhmon-off",
    mikrotik_username: "off",
    mikrotik_password: "off",
    plan: "24hr",
    mac_address: "",
    status: "processed",
    expires_at: null,
    created_at: "2026-10-22T10:00:00.000Z",
    customer_email: "Mikhmon (24hr)",
    customer_phone: "Mikhmon",
  });
  const res = await syncMikhmonUsers(db, [
    {
      name: "off",
      password: "off",
      profile: "24hrs",
      comment: VOUCHER_COMMENT,
      "limit-uptime": "1d00:00:00",
    },
  ], { firstLoginOnly: true, active: [] });

  assertEquals(res.updated, 1);
  assertEquals(db.tables.payment_queue[0].expires_at, "2026-10-23T10:00:00.000Z");
  assertEquals(res.preview[0].expires_at, "2026-10-23T10:00:00.000Z");
});

