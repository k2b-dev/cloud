import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { GEO_MAX_POLYLINE_CHARS, GeoGeocodeDataSchema, GeoPlaceSearchDataSchema, type GeoPlaceSearchInput } from "../../contracts/geo";
import * as settingsStore from "../settings/store";
import { createGeoBucket } from "./bucket";
import { createGeoCache, geoCacheKey } from "./cache";
import { geoReferenceCost, geoReserveCost } from "./costs";
import autocomplete from "./fixtures/autocomplete.json";
import geocode from "./fixtures/geocode.json";
import places from "./fixtures/places.json";
import { encodeGeoTestLine, GEO_TEST_KEY, GEO_TEST_NOW, geoTestConfig, geoTestContext } from "./geo.test-fixture";
import { GeoapifyAdapter } from "./geoapify";
import { cutGeoWindow, decodePolyline6, locateOnGeoLine, simplifyGeoLine } from "./polyline";
import { createGeoService } from "./service";
import { readGeoConfig } from "./settings";

const setup = (overrides: Partial<Parameters<typeof createGeoService>[0]> = {}, response: unknown = autocomplete) => {
  const fetch = mock(async () => Response.json(response));
  const reserve = mock(async (_subject, _config, cost: number, group: string) => ({ cost, group, rows: [] }));
  const settle = mock(async () => {});
  const recordTransition = mock(async () => {});
  const acquire = mock(async () => async () => {});
  const availability = mock(async () => ({
    configured: true,
    person: { exhausted: false, resetsAt: "2026-10-20T22:00:00.000Z" },
    cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" },
  }));
  const cacheGet = mock(async (_key: string) => null),
    cachePut = mock(async () => {});
  const service = createGeoService({
    config: async () => geoTestConfig,
    now: () => GEO_TEST_NOW,
    adapter: new GeoapifyAdapter({ fetch, now: () => GEO_TEST_NOW }),
    ledger: { reserve, settle, availability, recordTransition },
    bucket: { acquire },
    cache: { get: cacheGet, put: cachePut },
    ...overrides,
  });
  return { service, fetch, reserve, settle, recordTransition, acquire, availability, cacheGet, cachePut };
};
afterEach(() => mock.restore());
test("authentication and configuration fail before cache, admission, ledger or provider", async () => {
  const fixture = setup({ config: async () => ({ ...geoTestConfig, apiKey: "" }) });
  await expect(fixture.service.autocomplete({ text: "Orle" }, {})).rejects.toMatchObject({ code: "GEO_FORBIDDEN" });
  await expect(fixture.service.autocomplete({ text: "Orle" }, geoTestContext)).rejects.toMatchObject({ code: "GEO_NOT_CONFIGURED" });
  expect([
    fixture.fetch.mock.calls.length,
    fixture.reserve.mock.calls.length,
    fixture.acquire.mock.calls.length,
    fixture.cacheGet.mock.calls.length,
  ]).toEqual([0, 0, 0, 0]);
});
test("unreadable monthly budget refuses paid work and reports not configured without infrastructure", async () => {
  const values: Record<string, unknown> = {
    "geo.api_key": GEO_TEST_KEY,
    "geo.plan": geoTestConfig.plan,
    "geo.custom_rps": geoTestConfig.customRps,
    "geo.custom_daily_credits": geoTestConfig.customDailyCredits,
    "geo.monthly_budget_credits": geoTestConfig.monthlyCredits,
    "geo.person_daily_credits": geoTestConfig.personDailyCredits,
    "app.timezone": geoTestConfig.timezone,
  };
  spyOn(settingsStore, "readStates").mockImplementation(
    async (keys) =>
      new Map(
        keys.map((key) => [
          key,
          {
            stored: key === "geo.monthly_budget_credits" ? "unreadable" : "readable",
            value: values[key],
          },
        ]),
      ),
  );
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const f = setup({ config: readGeoConfig });
  for (const call of [
    () => f.service.autocomplete({ text: "Orle" }, geoTestContext),
    () => f.service.geocode({ text: "Ulm" }, geoTestContext),
    () => f.service.reverse({ point: { lat: 49, lon: 12 } }, geoTestContext),
    () => f.service.searchPlaces({ categories: ["museum"], near: { lat: 49, lon: 12 } }, geoTestContext),
  ]) {
    warn.mockClear();
    await expect(call()).rejects.toMatchObject({ code: "GEO_NOT_CONFIGURED" });
    expect(warn).toHaveBeenCalledTimes(1);
  }
  expect(await f.service.availability(geoTestContext)).toMatchObject({ configured: false });
  for (const dependency of [f.fetch, f.reserve, f.settle, f.recordTransition, f.acquire, f.cacheGet, f.cachePut, f.availability])
    expect(dependency).not.toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain(GEO_TEST_KEY);
});
test("all input bounds reject with structured recovery before admission or fetch", async () => {
  const f = setup();
  const check = async (promise: Promise<unknown>, limit: string) => {
    await expect(promise).rejects.toMatchObject({
      code: "GEO_LIMIT_EXCEEDED",
      details: { limit, max: expect.any(Number), actual: expect.any(Number) },
    });
  };
  for (const text of ["ab", "x".repeat(301), " ".repeat(300) + "abc"])
    await check(f.service.autocomplete({ text }, geoTestContext), "text");
  await check(f.service.autocomplete({ text: "Orle", limit: 6 }, geoTestContext), "limit");
  await check(f.service.geocode({ text: "x".repeat(301) }, geoTestContext), "text");
  for (const field of ["line1", "postalCode", "city", "stateRegion", "country"])
    await check(f.service.geocode({ fields: { [field]: "x".repeat(201) } }, geoTestContext), `fields.${field}`);
  const base: GeoPlaceSearchInput = { categories: ["museum"], near: { lat: 49, lon: 12 } };
  await check(
    f.service.searchPlaces({ ...base, categories: ["museum", "cafe", "pub", "park", "fuel", "parking"] }, geoTestContext),
    "categories",
  );
  await check(f.service.searchPlaces({ ...base, limit: 21 }, geoTestContext), "limit");
  const along = {
    polyline6: encodeGeoTestLine([
      { lat: 49, lon: 12 },
      { lat: 50, lon: 13 },
    ]),
    fromKm: 0,
    toKm: 100,
  };
  const withAlong = { categories: base.categories, along };
  await check(f.service.searchPlaces({ ...withAlong, along: { ...along, toKm: 201 } }, geoTestContext), "along.windowKm");
  for (const bufferMeters of [99, 5001])
    await check(f.service.searchPlaces({ ...withAlong, along: { ...along, bufferMeters } }, geoTestContext), "along.bufferMeters");
  await check(
    f.service.searchPlaces({ ...withAlong, along: { ...along, polyline6: "?".repeat(GEO_MAX_POLYLINE_CHARS + 1) } }, geoTestContext),
    "along.polyline6",
  );
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
});
test("unsupported combinations refuse without side effects", async () => {
  const f = setup();
  // Variables model untyped callers; the strict schema must refuse the removed limit.
  for (const limit of [1, 5, 6]) {
    const input = { text: "Ulm", limit };
    await expect(f.service.geocode(input, geoTestContext)).rejects.toMatchObject({ code: "GEO_UNSUPPORTED_OPTION" });
  }
  await expect(f.service.geocode({ text: "Ulm", fields: { city: "Ulm" } }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_UNSUPPORTED_OPTION",
  });
  await expect(f.service.searchPlaces({ categories: ["museum"] }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_UNSUPPORTED_OPTION",
  });
  await expect(
    f.service.searchPlaces(
      { categories: ["museum"], near: { lat: 49, lon: 12 }, area: { type: "circle", point: { lat: 49, lon: 12 }, radiusMeters: 1000 } },
      geoTestContext,
    ),
  ).rejects.toMatchObject({ code: "GEO_UNSUPPORTED_OPTION" });
  await expect(
    f.service.searchPlaces(
      {
        categories: ["museum"],
        along: {
          polyline6: encodeGeoTestLine([
            { lat: 0, lon: 0 },
            { lat: 0, lon: 180 },
          ]),
          fromKm: 0,
          toKm: 100,
        },
      },
      geoTestContext,
    ),
  ).rejects.toMatchObject({ code: "GEO_UNSUPPORTED_OPTION" });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.cacheGet).not.toHaveBeenCalled();
});
test("Valkey admission fails closed", async () => {
  const f = setup({
    bucket: createGeoBucket({
      redis: async () => {
        throw new Error("offline");
      },
    }),
  });
  await expect(f.service.autocomplete({ text: "Orle" }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_BUSY",
    details: { retryAfterSeconds: 1 },
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});
test("cache hit costs nothing and keeps original provenance", async () => {
  const values = new Map<string, string>();
  const cache = createGeoCache(async () => ({
    send: async (command, args) => {
      if (command === "GET") return values.get(args[0]!) ?? null;
      values.set(args[0]!, args[1]!);
      return "OK";
    },
  }));
  const f = setup({ cache });
  const first = await f.service.autocomplete({ text: " Orle " }, geoTestContext);
  const second = await f.service.autocomplete({ text: "orle" }, geoTestContext);
  expect(second).toEqual(first);
  expect(second.provenance.computedAt).toBe(GEO_TEST_NOW.toISOString());
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...values])).not.toContain(GEO_TEST_KEY);
});
test("cache failure skips cache and errors never enter it", async () => {
  const failing = createGeoCache(async () => {
    throw new Error("cache offline");
  });
  const f = setup({ cache: failing });
  await f.service.autocomplete({ text: "Orle" }, geoTestContext);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const bad = setup({}, {});
  await expect(bad.service.autocomplete({ text: "Orle" }, geoTestContext)).rejects.toMatchObject({ code: "GEO_PROVIDER_FAILED" });
  expect(bad.cachePut).not.toHaveBeenCalled();
});
test("abort after send stays spent with unknown costs and releases the lease", async () => {
  const controller = new AbortController(),
    release = mock(async () => {});
  const adapter = new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async () => {
      controller.abort(new Error(GEO_TEST_KEY));
      throw controller.signal.reason;
    },
  });
  const f = setup({ adapter, bucket: { acquire: async () => release } });
  await expect(f.service.autocomplete({ text: "Orle" }, { ...geoTestContext, signal: controller.signal })).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 0, unknownCredits: 1 } },
  });
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ cost: 1000 }), 1000);
  expect(release).toHaveBeenCalledTimes(1);
});
test("pre-send retries share one reservation and known pre-send failure refunds", async () => {
  for (const succeed of [true, false]) {
    let calls = 0;
    const f = setup({
      adapter: new GeoapifyAdapter({
        now: () => GEO_TEST_NOW,
        fetch: async () => {
          if (++calls === 1 || !succeed) throw Object.assign(new Error(GEO_TEST_KEY), { code: "ECONNREFUSED" });
          return Response.json(autocomplete);
        },
      }),
    });
    if (succeed) await f.service.autocomplete({ text: "Orle" }, geoTestContext);
    else
      await expect(f.service.autocomplete({ text: "Orle" }, geoTestContext)).rejects.toMatchObject({
        details: { costs: { settledCredits: 0, unknownCredits: 0 } },
      });
    expect(calls).toBe(2);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ cost: 1000 }), succeed ? 1000 : 0);
  }
});
test("provider failures expose recovery and never key, logs or cache", async () => {
  const logs: unknown[] = [];
  for (const method of ["log", "error", "warn"] as const)
    spyOn(console, method).mockImplementation((...args) => {
      logs.push(args);
    });
  for (const status of [401, 429]) {
    const f = setup({
      adapter: new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => new Response(GEO_TEST_KEY, { status }) }),
    });
    let error: unknown;
    try {
      await f.service.autocomplete({ text: "Orle" }, geoTestContext);
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      code: status === 401 ? "GEO_PROVIDER_FAILED" : "GEO_BUSY",
      details: { costs: { settledCredits: 1, unknownCredits: 0 } },
    });
    if (status === 401) {
      expect(error).toMatchObject({ details: { adminHint: expect.any(String) } });
      expect(f.recordTransition).toHaveBeenCalledTimes(1);
    }
    expect(JSON.stringify([error, logs, f.recordTransition.mock.calls, f.cachePut.mock.calls])).not.toContain(GEO_TEST_KEY);
    expect(f.cachePut).not.toHaveBeenCalled();
  }
});
test("geocode reports none, ambiguity and unique plausible candidates", async () => {
  const none = setup({}, { type: "FeatureCollection", features: [] });
  await expect(none.service.geocode({ text: "Not known" }, geoTestContext)).rejects.toMatchObject({ code: "GEO_ADDRESS_NOT_FOUND" });
  const candidate = geocode.features[0]!;
  const lowConfidence = { ...candidate, properties: { ...candidate.properties, rank: { confidence: 0.49 } } };
  const implausible = setup({}, { ...geocode, features: [lowConfidence] });
  await expect(implausible.service.geocode({ text: "Uncertain" }, geoTestContext)).rejects.toMatchObject({ code: "GEO_ADDRESS_NOT_FOUND" });
  const ambiguous = setup({}, { ...geocode, features: [candidate, candidate] });
  await expect(ambiguous.service.geocode({ text: "Lessingstraße" }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_ADDRESS_AMBIGUOUS",
    details: { candidates: expect.arrayContaining([expect.objectContaining({ point: expect.any(Object) })]) },
  });
  expect(ambiguous.cachePut).not.toHaveBeenCalled();
  // Every supported address representation requests the full five-candidate check.
  for (const input of [{ text: "Lessingstraße", countryCode: "DE" }, { fields: { city: "Ulm" } }]) {
    const f = setup({}, { ...geocode, features: Array(6).fill(candidate) });
    const error: unknown = await f.service.geocode(input, geoTestContext).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "GEO_ADDRESS_AMBIGUOUS", details: { candidates: { length: 5 } } });
  }
  const found = setup({}, { ...geocode, features: [lowConfidence, candidate] });
  expect(
    GeoGeocodeDataSchema.parse(await found.service.geocode({ text: "Lessingstraße" }, geoTestContext)).address.confidence,
  ).toBeGreaterThanOrEqual(0.5);
  expect(found.cacheGet).toHaveBeenCalledWith(
    geoCacheKey("geocode", { text: "Lessingstraße" }, geoTestContext.locale ?? "en"),
    GeoGeocodeDataSchema,
  );
});
test("along uses window on full-route distance and filters/orders corridor hits", async () => {
  const features = [0.8, 0.4, 0.6].map((lon, i) => ({
    ...places.features[0]!,
    properties: { ...places.features[0]!.properties, lat: 0, lon, place_id: `place-${i}` },
  }));
  features.push(
    { ...features[0]!, properties: { ...features[0]!.properties, lat: 0.1, lon: 0.5 } },
    { ...features[0]!, properties: { ...features[0]!.properties, lat: 0, lon: 0.2 } },
    { ...features[0]!, properties: { ...features[0]!.properties, lat: 0, lon: 0.95 } },
  );
  const fixture = setup({}, { ...places, features });
  const result = await fixture.service.searchPlaces(
    {
      categories: ["museum"],
      along: {
        polyline6: encodeGeoTestLine([
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1 },
        ]),
        fromKm: 40,
        toKm: 100,
        bufferMeters: 500,
      },
    },
    geoTestContext,
  );
  expect(result.places.map((p) => p.point.lon)).toEqual([0.4, 0.6, 0.8]);
  expect(result.places[0]!.atMeters).toBeCloseTo(44478, 0);
  expect(result.places.every((p) => p.distanceToRouteMeters! < 1)).toBeTrue();
});
test("along widens the provider corridor for simplification and filters against the original route", async () => {
  const route = Array.from({ length: 3001 }, (_, i) => ({ lat: (i % 2) * 0.0001, lon: i * 0.000005 }));
  const along = { polyline6: encodeGeoTestLine(route), fromKm: 0, toKm: 100, bufferMeters: 100 };
  const cut = cutGeoWindow(decodePolyline6(along.polyline6), 0, 100000);
  const features = [92, 108].map((distance) => ({
    ...places.features[0]!,
    properties: {
      ...places.features[0]!.properties,
      lat: 0.0001 + (distance / 6_371_008.8) * (180 / Math.PI),
      lon: route[1001]!.lon,
      place_id: `corridor-${distance}`,
    },
  }));
  let providerBuffer = 0,
    providerHits = 0;
  const f = setup({
    adapter: new GeoapifyAdapter({
      now: () => GEO_TEST_NOW,
      fetch: async (_url, init) => {
        const { filter } = z
          .object({
            filter: z.object({
              buffer: z.number(),
              geometry: z.object({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
            }),
          })
          .parse(JSON.parse(String(init.body)));
        const line = filter.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
        expect(line.length).toBeLessThanOrEqual(2000);
        const point = features[0]!.properties;
        expect(locateOnGeoLine(point, cut).distanceToRouteMeters).toBeCloseTo(92, 0);
        expect(locateOnGeoLine(point, line).distanceToRouteMeters).toBeGreaterThan(100);
        providerBuffer = filter.buffer;
        const hits = features.filter((feature) => locateOnGeoLine(feature.properties, line).distanceToRouteMeters <= filter.buffer);
        providerHits = hits.length;
        return Response.json({ ...places, features: hits });
      },
    }),
  });
  const result = GeoPlaceSearchDataSchema.parse(await f.service.searchPlaces({ categories: ["museum"], along }, geoTestContext));
  expect(result.simplificationToleranceMeters).toBeGreaterThan(0);
  expect(providerBuffer).toBe(132);
  expect(providerHits).toBe(2);
  expect(result.places.map((place) => place.id)).toEqual(["corridor-92"]);
  expect(result.places[0]!.distanceToRouteMeters).toBeCloseTo(92, 0);
  expect(along.bufferMeters).toBe(100);
});
test.each([true, false])(
  "along filters before limiting and reports a bounded incomplete search (valid candidate: %s)",
  async (hasValid) => {
    const route = Array.from({ length: 3001 }, (_, i) => ({ lat: (i % 2) * 0.0001, lon: i * 0.000005 }));
    const features = Array.from({ length: 20 }, (_, i) => ({
      ...places.features[0]!,
      properties: {
        ...places.features[0]!.properties,
        lat: 0.0001 + ((hasValid && i === 19 ? 92 : 108) / 6_371_008.8) * (180 / Math.PI),
        lon: route[1001]!.lon,
        place_id: `candidate-${i}`,
      },
    }));
    const f = setup({
      adapter: new GeoapifyAdapter({
        now: () => GEO_TEST_NOW,
        fetch: async (_url, init) => {
          const body = z.object({ limit: z.number() }).parse(JSON.parse(String(init.body)));
          expect(body.limit).toBe(20);
          return Response.json({ ...places, features: features.slice(0, body.limit) });
        },
      }),
    });
    const result = await f.service.searchPlaces(
      {
        categories: ["museum"],
        limit: 1,
        along: { polyline6: encodeGeoTestLine(route), fromKm: 0, toKm: 100, bufferMeters: 100 },
      },
      geoTestContext,
    );
    expect(result.places.map((place) => place.id)).toEqual(hasValid ? ["candidate-19"] : []);
    expect(result.truncated).toBe(!hasValid);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.reserve.mock.calls[0]?.[2]).toBe(1000);
  },
);
test("along cache keys distinguish original routes that simplify to the same line", async () => {
  const routes = [1, -1].map((direction) =>
    encodeGeoTestLine(Array.from({ length: 2001 }, (_, i) => ({ lat: i % 2 ? direction * 0.000001 : 0, lon: i * 0.000005 }))),
  );
  const simplified = routes.map((route) => simplifyGeoLine(cutGeoWindow(decodePolyline6(route), 0, 2000)).line);
  expect(simplified[0]).toEqual(simplified[1]);
  expect(simplified[0]).toHaveLength(2);
  const f = setup({}, { ...places, features: [] });
  for (const polyline6 of routes) {
    const along = { polyline6, fromKm: 0, toKm: 2 };
    await f.service.searchPlaces({ categories: ["museum", "cafe"], along }, geoTestContext);
    expect(f.cacheGet.mock.lastCall?.[0]).toBe(
      geoCacheKey(
        "places",
        {
          categories: ["museum", "cafe"],
          limit: 20,
          along: { ...along, bufferMeters: 1000 },
        },
        geoTestContext.locale!,
      ),
    );
  }
  expect(f.cacheGet.mock.calls[0]?.[0]).not.toBe(f.cacheGet.mock.calls[1]?.[0]);
  await f.service.searchPlaces(
    {
      categories: ["cafe", "museum"],
      limit: 20,
      along: { polyline6: routes[0]!, fromKm: 0, toKm: 2, bufferMeters: 1000 },
    },
    geoTestContext,
  );
  expect(f.cacheGet.mock.calls[2]?.[0]).toBe(f.cacheGet.mock.calls[0]?.[0]);
});
test("availability is free and not-configured availability touches no infrastructure", async () => {
  const f = setup();
  await f.service.availability(geoTestContext);
  expect(f.availability).toHaveBeenCalledTimes(1);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
  const absent = setup({ config: async () => ({ ...geoTestConfig, apiKey: "" }) });
  expect(await absent.service.availability(geoTestContext)).toMatchObject({ configured: false });
  expect(absent.availability).not.toHaveBeenCalled();
});
test("costs are integer millicredits and chains reserve every step", () => {
  expect(geoReserveCost([{ fn: "geocode" }, { fn: "places", limit: 20 }])).toBe(2000);
  expect(geoReferenceCost({ fn: "places", limit: 21 })).toBe(2000);
  expect(geoReferenceCost({ fn: "places", limit: 20 })).toBe(1000);
});
test("normalization includes locale, sorted categories, rounded bias/reverse, limits", () => {
  expect(geoCacheKey("autocomplete", { text: "  Ab  Cd ", bias: { lat: 49.001, lon: 12 } }, "de")).toBe(
    geoCacheKey("autocomplete", { bias: { lat: 49.002, lon: 12 }, text: "ab cd" }, "de"),
  );
  expect(geoCacheKey("reverse", { point: { lat: 49.000001, lon: 12 } }, "de")).toBe(
    geoCacheKey("reverse", { point: { lat: 49.000002, lon: 12 } }, "de"),
  );
  expect(geoCacheKey("places", { categories: ["cafe", "museum"] }, "de")).toBe(
    geoCacheKey("places", { categories: ["museum", "cafe"] }, "de"),
  );
  expect(geoCacheKey("reverse", { point: { lat: 49, lon: 12 } }, "en")).not.toBe(
    geoCacheKey("reverse", { point: { lat: 49, lon: 12 } }, "de"),
  );
});
test("an audit outage preserves the provider failure and costs without logging credentials", async () => {
  const f = setup({
    adapter: new GeoapifyAdapter({ now: () => GEO_TEST_NOW, fetch: async () => new Response(GEO_TEST_KEY, { status: 401 }) }),
  });
  f.recordTransition.mockRejectedValue(new Error(GEO_TEST_KEY));
  const log = spyOn(console, "error").mockImplementation(() => {});
  await expect(f.service.autocomplete({ text: "Orle" }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { adminHint: expect.any(String), costs: { settledCredits: 1, unknownCredits: 0 } },
  });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain(GEO_TEST_KEY);
});
