import { afterAll, beforeAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { DASHBOARD_CACHE_BYTES, DASHBOARD_CACHE_ENTRIES } from "../dashboard-contracts";
import { createDashboardCache, type DashboardSnapshot } from "./dashboard-cache";

suiteFor("valkey")("bounded dashboard result cache", () => {
  const namespace = `test:pulse:dashboards:${crypto.randomUUID()}`;
  let a: ReturnType<typeof createDashboardCache>;
  let b: ReturnType<typeof createDashboardCache>;
  beforeAll(() => {
    a = createDashboardCache({ url: requireInfraUrl("valkey"), namespace });
    b = createDashboardCache({ url: requireInfraUrl("valkey"), namespace });
  });
  const snapshot: DashboardSnapshot = {
    at: "2026-10-22T12:00:00Z",
    from: "2026-10-21T12:00:00Z",
    to: "2026-10-22T12:00:00Z",
    slot: "2026-10-22T12:00:00.000Z",
    data: { columns: [], rows: [] },
  };
  afterAll(async () => {
    a.close();
    b.close();
    const redis = new RedisClient(requireInfraUrl("valkey"));
    try {
      await redis.send("DEL", [`${namespace}:entries`, `${namespace}:age`, `${namespace}:bytes`]);
    } finally {
      redis.close();
    }
  });
  test("a delayed previous slot never overwrites a newer replica result", async () => {
    const newer = { ...snapshot, slot: "2026-10-22T12:01:00.000Z", data: { columns: [], rows: [[2]] } };
    expect(await a.put("race", newer)).toBe(true);
    expect(await b.put("race", snapshot)).toBe(false);
    expect(await a.read("race")).toEqual(newer);
  });
  test("replicas preserve empty arrays and evict by entry count and byte budget", async () => {
    expect(await a.put("first", snapshot)).toBe(true);
    expect(await b.read("first")).toEqual(snapshot);
    for (let i = 0; i < DASHBOARD_CACHE_ENTRIES; i++) await b.put(`entry-${i}`, snapshot);
    expect(await a.read("first")).toBeNull();
    expect(await a.read(`entry-${DASHBOARD_CACHE_ENTRIES - 1}`)).toEqual(snapshot);
    const large = { ...snapshot, data: { columns: [{ name: "text", type: "String" }], rows: [["x".repeat(2 * 1024 * 1024)]] } };
    for (let i = 0; i < 33; i++) await a.put(`large-${i}`, large);
    expect(await b.read("large-0")).toBeNull();
    const redis = new RedisClient(requireInfraUrl("valkey"));
    try {
      const values = await redis.hgetall(`${namespace}:entries`);
      const entries = Object.entries(values ?? {});
      expect(entries.length).toBeLessThanOrEqual(DASHBOARD_CACHE_ENTRIES);
      expect(entries.reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(
        DASHBOARD_CACHE_BYTES,
      );
    } finally {
      redis.close();
    }
  });
});
