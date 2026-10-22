import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  dateKey,
  priceOf,
  revenueByDay,
  revenueByMonth,
  sumRevenue,
} from "./revenue.ts";

Deno.test("priceOf uses the London plan prices", () => {
  assertEquals(priceOf("24hr"), 300);
  assertEquals(priceOf("3d"), 1000);
  assertEquals(priceOf("5d"), 1500);
  assertEquals(priceOf("7d"), 2000);
  assertEquals(priceOf("14d"), 3500);
  assertEquals(priceOf("30d"), 5000);
  assertEquals(priceOf("6h"), 0);
  assertEquals(priceOf("default"), 0);
});

Deno.test("dateKey is Lagos local date", () => {
  assertEquals(dateKey("2026-10-22T23:30:00Z"), "2026-10-23");
  assertEquals(dateKey("2026-10-22T10:00:00Z"), "2026-10-22");
});

Deno.test("sumRevenue filters from a Lagos date and ignores free plans", () => {
  const rows = [
    { plan: "24hr", created_at: "2026-10-21T10:00:00Z" },
    { plan: "3d", created_at: "2026-10-22T10:00:00Z" },
    { plan: "24hr", created_at: "2026-10-23T10:00:00Z" },
    { plan: "6h", created_at: "2026-10-23T10:00:00Z" },
  ];
  assertEquals(sumRevenue(rows), 1600);
  assertEquals(sumRevenue(rows, "2026-10-22"), 1300);
  assertEquals(sumRevenue(rows, "2026-10-23"), 300);
});

Deno.test("revenueByMonth and revenueByDay group correctly", () => {
  const rows = [
    { plan: "24hr", created_at: "2026-10-22T10:00:00Z" },
    { plan: "24hr", created_at: "2026-10-22T12:00:00Z" },
    { plan: "3d", created_at: "2026-10-23T10:00:00Z" },
  ];
  assertEquals(revenueByMonth(rows)["2026-10"], 1600);
  assertEquals(revenueByDay(rows, "2026-10"), { 22: 600, 23: 1000 });
});
