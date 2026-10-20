import { expect, test } from "bun:test";
import { z } from "zod";
import { createGeoCache, GEO_MAX_JSON_BYTES } from "./cache";

test("cache uses function TTLs and a short TTL for empty results", async () => {
  const writes: string[][] = [];
  const cache = createGeoCache(async () => ({
    send: async (_command, args) => {
      writes.push(args);
      return "OK";
    },
  }));
  for (const fn of ["autocomplete", "geocode", "reverse", "places"] as const) await cache.put("key", fn, { results: [] }, false);
  await cache.put("key", "places", { results: [] }, true);
  expect(writes.map((args) => args[3])).toEqual(["604800", "2592000", "2592000", "86400", "3600"]);
});
test("oversized entries are skipped and corrupt entries are misses", async () => {
  let calls = 0;
  const cache = createGeoCache(async () => ({
    send: async () => {
      calls++;
      return "OK";
    },
  }));
  await cache.put("key", "places", "x".repeat(GEO_MAX_JSON_BYTES), false);
  expect(calls).toBe(0);
  for (const value of [null, "{", '{"wrong":true}', "x".repeat(GEO_MAX_JSON_BYTES + 1)]) {
    const reader = createGeoCache(async () => ({ send: async () => value }));
    expect(await reader.get("key", z.object({ results: z.array(z.string()) }))).toBeNull();
  }
});
