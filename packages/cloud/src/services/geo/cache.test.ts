import { expect, test } from "bun:test";
import { z } from "zod";
import { createGeoCache, geoCacheKey, normalizeGeoInput, GEO_MAX_JSON_BYTES } from "./cache";

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

test("only autocomplete bias uses coarse coordinate rounding", () => {
  const circle = (lat: number, radiusMeters = 1000) => ({ text: "Ulm", area: { type: "circle", point: { lat, lon: 10 }, radiusMeters } });
  expect(geoCacheKey("autocomplete", circle(48.001), "en")).not.toBe(geoCacheKey("autocomplete", circle(48.004), "en"));
  expect(geoCacheKey("autocomplete", { text: "Ulm", bias: { lat: 48.001, lon: 10 } }, "en")).toBe(
    geoCacheKey("autocomplete", { text: "Ulm", bias: { lat: 48.004, lon: 10 } }, "en"),
  );
  expect(geoCacheKey("autocomplete", circle(48, 1000.001), "en")).not.toBe(geoCacheKey("autocomplete", circle(48, 1000.004), "en"));
  expect(
    normalizeGeoInput(
      {
        bias: { lat: 48.001234, lon: 10.004321 },
        area: { type: "bbox", west: 10.001234, south: 48.001234, east: 11.004321, north: 49.004321 },
      },
      "autocomplete",
    ),
  ).toEqual({
    bias: { lat: 48, lon: 10 },
    area: { type: "bbox", west: 10.00123, south: 48.00123, east: 11.00432, north: 49.00432 },
  });
  for (const [fn, input] of [
    ["autocomplete", circle(48.001234)],
    ["places", { near: { lat: 48.001234, lon: 10.004321 } }],
    ["reverse", { point: { lat: 48.001234, lon: 10.004321 } }],
  ] as const) {
    expect(JSON.stringify(normalizeGeoInput(input, fn))).toContain("48.00123");
  }
});
