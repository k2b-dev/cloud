import { expect, mock, test } from "bun:test";
import { GeoErrorDetailsSchema, type GeoFunction } from "../../contracts/geo";
import { type GeoRouteCalculateInput, GeoRouteSchema, type GeoRouteStop } from "../../contracts/geo-route";
import type { GeoRedis } from "./bucket";
import { createGeoCache, GEO_MAX_JSON_BYTES } from "./cache";
import geocode from "./fixtures/geocode.json";
import routing from "./fixtures/routing.json";
import { encodeGeoTestLine, GEO_TEST_KEY, GEO_TEST_NOW, geoTestConfig, geoTestContext } from "./geo.test-fixture";
import { GeoapifyAdapter } from "./geoapify";
import { routeStops, syntheticRouteResponse } from "./route.test-fixture";
import { geoRouteReferenceCost } from "./route-costs";
import { createGeoService } from "./service";

const setup = (
  options: {
    response?: (url: URL, init: RequestInit) => Response | Promise<Response>;
    cache?: ReturnType<typeof createGeoCache>;
    daily?: number;
  } = {},
) => {
  const events: string[] = [];
  let used = 0;
  const fetch = mock(async (url: URL, init: RequestInit) => {
    events.push(`provider:${url.pathname}`);
    expect(url.origin).toBe("https://api-eu.geoapify.com");
    expect(url.searchParams.has("apiKey")).toBeFalse();
    expect(new Headers(init.headers).get("x-api-key")).toBe(GEO_TEST_KEY);
    return options.response ? options.response(url, init) : Response.json(syntheticRouteResponse(url));
  });
  const reserve = mock(async (_subject, _config, cost: number, group: string) => {
    events.push(`reserve:${cost}`);
    if (used + cost > (options.daily ?? 90000) * 1000)
      throw new (await import("./errors")).GeoError("GEO_BUDGET_EXHAUSTED", { scope: "person", resetsAt: "2026-10-20T22:00:00.000Z" });
    used += cost;
    return { cost, group, rows: [] };
  });
  const settle = mock(async (reservation: { cost: number }, cost: number) => {
    events.push(`settle:${cost}`);
    used += cost - reservation.cost;
  });
  const acquire = mock(async (fn: GeoFunction) => {
    events.push(`acquire:${fn}`);
    return async () => {
      events.push(`release:${fn}`);
    };
  });
  const cacheGet = mock(async (_key: string): Promise<null> => null);
  const cachePut = mock(async () => {});
  const service = createGeoService({
    config: async () => ({ ...geoTestConfig, personDailyCredits: options.daily ?? 90000 }),
    now: () => GEO_TEST_NOW,
    adapter: new GeoapifyAdapter({ fetch, now: () => GEO_TEST_NOW }),
    bucket: { acquire },
    cache: options.cache ?? { get: cacheGet, put: cachePut },
    ledger: {
      reserve,
      settle,
      availability: async () => ({
        person: { exhausted: false, resetsAt: "2026-10-20T22:00:00.000Z" },
        cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" },
      }),
      recordTransition: async () => {},
    },
  });
  return { service, fetch, reserve, settle, acquire, cacheGet, cachePut, events, used: () => used };
};
const calculate = (stops = routeStops(4)): GeoRouteCalculateInput => ({ plan: { stops } });

test("calculate uses the public contract, header-only EU transport and frozen provenance", async () => {
  const f = setup({ response: () => Response.json(routing) });
  const result = await f.service.calculateRoute(calculate(routeStops(3)), geoTestContext);
  expect(result.route).toMatchObject({
    distanceMeters: 3000,
    durationSeconds: 300,
    distanceAllowanceMeters: 500000,
    options: { mode: "car", avoid: [] },
    provenance: { computedAt: GEO_TEST_NOW.toISOString() },
  });
  expect(GeoRouteSchema.safeParse(result.route).success).toBeTrue();
  expect(f.events[0]).toBe("reserve:4000"); // two pairs × two distance bands
  expect(f.used()).toBe(2000);
  const url = f.fetch.mock.calls[0]![0];
  for (const [key, value] of Object.entries({
    mode: "drive",
    units: "metric",
    traffic: "free_flow",
    format: "json",
    intermediate_waypoint_mode: "stopover",
  }))
    expect(url.searchParams.get(key)).toBe(value);
  expect(url.searchParams.has("details")).toBeFalse(); // JSON geometry is sufficient; avoid duplicate encoded lines.
  expect(JSON.stringify(result)).not.toContain(GEO_TEST_KEY);
});

test("limits, identity, unknown fields, duplicate IDs and unsupported modes fail before paid work", async () => {
  const f = setup();
  await expect(f.service.calculateRoute(calculate(), {})).rejects.toMatchObject({ code: "GEO_FORBIDDEN" });
  for (const input of [
    calculate(routeStops(1)),
    calculate(routeStops(27)),
    { plan: { stops: [routeStops(2)[0], routeStops(2)[0]] } },
    { plan: { stops: routeStops(2), options: { mode: "truck" } } },
    { plan: { stops: routeStops(2), surprise: true } },
    { plan: { stops: routeStops(2), options: { mode: "bike", avoid: ["highways"] } } },
    { plan: { stops: [{ id: "A", point: { lat: 48, lon: 10 }, address: { text: "Fixture" } }, routeStops(2)[1]] } },
  ])
    await expect(f.service.calculateRoute(input as GeoRouteCalculateInput, geoTestContext)).rejects.toMatchObject({
      code: expect.stringMatching(/^GEO_(LIMIT_EXCEEDED|UNSUPPORTED_OPTION)$/),
    });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});

test("all modes map to the provider, avoid preferences are normalized and walk distance preflights", async () => {
  for (const [mode, provider] of [
    ["car", "drive"],
    ["bike", "bicycle"],
    ["walk", "walk"],
  ] as const) {
    const f = setup();
    await f.service.calculateRoute({ plan: { stops: routeStops(2), options: { mode, avoid: ["ferries", "ferries"] } } }, geoTestContext);
    expect(f.fetch.mock.calls[0]![0].searchParams.get("mode")).toBe(provider);
    expect(f.fetch.mock.calls[0]![0].searchParams.get("avoid")).toBe("ferries");
  }
  const f = setup();
  for (const plan of [
    {
      stops: [
        { id: "A", point: { lat: 0, lon: 0 } },
        { id: "B", point: { lat: 2, lon: 0 } },
      ],
      options: { mode: "walk" as const },
    },
    {
      stops: [
        { id: "A", point: { lat: 0, lon: 0 } },
        { id: "B", point: { lat: 0, lon: 10 } },
      ],
    },
  ])
    await expect(f.service.calculateRoute({ plan }, geoTestContext)).rejects.toMatchObject({ code: "GEO_LIMIT_EXCEEDED" });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});

test("address geocodes and routing reserve once before the first provider call, deduplicating addresses", async () => {
  const f = setup({
    response: (url) =>
      Response.json(
        url.pathname.includes("geocode") ? { ...geocode, features: geocode.features.slice(0, 1) } : syntheticRouteResponse(url),
      ),
  });
  const stops: GeoRouteStop[] = [
    { id: "A", address: { text: "Fixture city" } },
    { id: "B", address: { text: "Fixture city" } },
  ];
  const result = await f.service.calculateRoute(calculate(stops), geoTestContext);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.events[0]).toBe("reserve:2000");
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.used()).toBe(2000);
  expect(result.route.stops.every((stop) => !!stop.address)).toBeTrue();
});

test("ambiguous geocodes identify the stop, charge the completed lookup, and never route", async () => {
  const ambiguous = structuredClone(geocode);
  ambiguous.features.push(structuredClone(ambiguous.features[0]!));
  const f = setup({ response: () => Response.json(ambiguous) });
  try {
    await f.service.calculateRoute(calculate([{ id: "A", address: { text: "Fixture" } }, routeStops(2)[1]!]), geoTestContext);
    throw new Error("Expected ambiguity");
  } catch (error) {
    expect(error).toMatchObject({
      code: "GEO_ADDRESS_AMBIGUOUS",
      details: { stopId: "A", candidates: expect.any(Array), costs: { settledCredits: 1, unknownCredits: 0 } },
    });
  }
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.used()).toBe(1000);
});

test("budget refusal happens before geocoding, including when the route would cost only one credit", async () => {
  const f = setup({ daily: 1 });
  await expect(
    f.service.calculateRoute(calculate([{ id: "A", address: { text: "Fixture" } }, routeStops(2)[1]!]), geoTestContext),
  ).rejects.toMatchObject({ code: "GEO_LIMIT_EXCEEDED", details: { limit: "reservationCredits", actual: 2, max: 1 } });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
});

test("insertion examines exactly three candidate gaps, reuses other legs, and reports deltas", async () => {
  const f = setup();
  const original = (await f.service.calculateRoute(calculate(routeStops(8)), geoTestContext)).route;
  const beforeCalls = f.fetch.mock.calls.length;
  const result = await f.service.updateRoute(
    { route: original, changes: { type: "insert", stop: { id: "X", point: { lat: 48.025, lon: 10.025 } } } },
    geoTestContext,
  );
  expect(f.fetch.mock.calls.length - beforeCalls).toBe(3);
  expect(result.insertion).toMatchObject({ candidateGaps: 3, exhaustive: false });
  expect(result.route.stops).toHaveLength(9);
  expect(result.route.legs).toHaveLength(8);
  expect(result.delta.distanceMeters).toBeCloseTo(result.after.distanceMeters - result.before.distanceMeters);
  expect(result.delta.durationSeconds).toBeCloseTo(result.after.durationSeconds - result.before.durationSeconds);
  expect(result.route.legs.filter((leg) => original.legs.some((old) => JSON.stringify(old) === JSON.stringify(leg)))).toHaveLength(6);
  expect(f.reserve.mock.calls.at(-1)![2]).toBe(12000);
});

test("explicit insertion and a small route compare only the requested/existing gaps", async () => {
  const f = setup();
  const original = (await f.service.calculateRoute(calculate(routeStops(3)), geoTestContext)).route;
  let previous = f.fetch.mock.calls.length;
  const best = await f.service.updateRoute(
    { route: original, changes: { type: "insert", stop: { id: "X", point: { lat: 48.005, lon: 10.005 } } } },
    geoTestContext,
  );
  expect(f.fetch.mock.calls.length - previous).toBe(2);
  expect(best.insertion?.exhaustive).toBeTrue();
  previous = f.fetch.mock.calls.length;
  const chosen = await f.service.updateRoute(
    { route: original, changes: { type: "insert", stop: { id: "X", point: { lat: 48.005, lon: 10.005 } }, afterStopId: "B" } },
    geoTestContext,
  );
  expect(f.fetch.mock.calls.length - previous).toBe(1);
  expect(chosen.route.stops.map((stop) => stop.id)).toEqual(["A", "B", "X", "C"]);
});

test("move reroutes affected edges only, preserving per-departure options", async () => {
  const f = setup();
  const original = (
    await f.service.calculateRoute(
      { plan: { stops: routeStops(6), legOptions: [{ fromStopId: "B", toStopId: "C", options: { avoid: ["highways"] } }] } },
      geoTestContext,
    )
  ).route;
  const previous = f.fetch.mock.calls.length;
  const result = await f.service.updateRoute({ route: original, changes: { type: "move", stopId: "C", toIndex: 3 } }, geoTestContext);
  expect(result.after.stopIds).toEqual(["A", "B", "D", "C", "E", "F"]);
  expect(f.fetch.mock.calls.length - previous).toBe(2);
  expect(result.route.legs.find((leg) => leg.fromStopId === "B")).toMatchObject({ toStopId: "D", options: { avoid: ["highways"] } });
  const count = f.fetch.mock.calls.length;
  const unchanged = await f.service.updateRoute(
    { route: result.route, changes: { type: "move", stopId: "C", toIndex: 3 } },
    geoTestContext,
  );
  expect(unchanged.delta).toEqual({ distanceMeters: 0, durationSeconds: 0 });
  expect(f.fetch.mock.calls.length).toBe(count);
});

test("leg options replace just that leg; route defaults replace every changed leg", async () => {
  const f = setup();
  const original = (await f.service.calculateRoute(calculate(), geoTestContext)).route;
  const result = await f.service.updateRoute(
    { route: original, changes: { type: "options", leg: { fromStopId: "B", toStopId: "C" }, options: { mode: "walk" } } },
    geoTestContext,
  );
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(result.route.legs[1]!.options.mode).toBe("walk");
  expect(result.route.legs[0]).toEqual(original.legs[0]);
  expect(result.route.legs[2]).toEqual(original.legs[2]);
  await f.service.updateRoute({ route: result.route, changes: { type: "options", options: { mode: "bike", avoid: [] } } }, geoTestContext);
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

test("optimization fixes endpoints, validates the permutation, and reapplies outgoing options", async () => {
  const f = setup({
    response: (url) =>
      Response.json(syntheticRouteResponse(url, url.searchParams.get("optimize_stops") === "true" ? { order: [0, 2, 1, 3] } : {})),
  });
  const original = (
    await f.service.calculateRoute(
      { plan: { stops: routeStops(4), legOptions: [{ fromStopId: "B", toStopId: "C", options: { avoid: ["highways"] } }] } },
      geoTestContext,
    )
  ).route;
  const result = await f.service.updateRoute({ route: original, changes: { type: "optimize" } }, geoTestContext);
  expect(result.after.stopIds).toEqual(["A", "C", "B", "D"]);
  expect(result.route.legs.find((leg) => leg.fromStopId === "B")).toMatchObject({ toStopId: "D", options: { avoid: ["highways"] } });
  expect(f.reserve.mock.calls.at(-1)![2]).toBe(23000); // 7×3 bands + overridden pair (2)
});

test("known cost overrun truthfully debits beyond reservation and blocks all future calls", async () => {
  const f = setup({ daily: 1, response: (url) => Response.json(syntheticRouteResponse(url, { distances: [600000] })) });
  try {
    await f.service.calculateRoute(calculate(routeStops(2)), geoTestContext);
    throw new Error("Expected overrun");
  } catch (error) {
    expect(error).toMatchObject({
      code: "GEO_COST_OVERRUN",
      details: { distanceAllowanceMeters: 500000, actualDistanceMeters: 600000, costs: { settledCredits: 2, unknownCredits: 0 } },
    });
    if (error && typeof error === "object" && "details" in error && "code" in error)
      expect(GeoErrorDetailsSchema.safeParse({ code: error.code, ...Object(error.details) }).success).toBeTrue();
  }
  expect(f.used()).toBe(2000);
  await expect(f.service.calculateRoute(calculate(routeStops(2)), geoTestContext)).rejects.toMatchObject({ code: "GEO_BUDGET_EXHAUSTED" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test("overrun stops subsequent leg calls and unknown timeout costs remain spent", async () => {
  const f = setup({ response: (url) => Response.json(syntheticRouteResponse(url, { distances: [600000] })) });
  await expect(
    f.service.calculateRoute(
      { plan: { stops: routeStops(3), legOptions: [{ fromStopId: "B", toStopId: "C", options: { mode: "walk" } }] } },
      geoTestContext,
    ),
  ).rejects.toMatchObject({ code: "GEO_COST_OVERRUN" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.used()).toBe(2000);
  const timeout = setup({
    response: () => {
      throw new DOMException("contains-secret-provider-cause", "AbortError");
    },
  });
  await expect(timeout.service.calculateRoute(calculate(routeStops(2)), geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 0, unknownCredits: 1 } },
  });
  expect(timeout.used()).toBe(1000);
  expect(timeout.fetch).toHaveBeenCalledTimes(1);
});

test("cached routes are free, preserve casing/precise coordinates, and avoid ledger writes", async () => {
  const memory = new Map<string, string>();
  const redis: GeoRedis = {
    send: async (command, args) => (command === "GET" ? (memory.get(args[0]!) ?? null) : (memory.set(args[0]!, args[1]!), "OK")),
  };
  const f = setup({ cache: createGeoCache(async () => redis) });
  const input = calculate(routeStops(2));
  const a = await f.service.calculateRoute(input, geoTestContext),
    b = await f.service.calculateRoute(input, geoTestContext);
  expect(a).toEqual(b);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  await f.service.calculateRoute(
    { plan: { ...input.plan, optimize: false, options: { mode: "car", avoid: [] }, distanceAllowanceMeters: 500000 } },
    geoTestContext,
  );
  expect(f.reserve).toHaveBeenCalledTimes(1);
  const lower = structuredClone(input);
  lower.plan.stops[0]!.id = "a";
  expect((await f.service.calculateRoute(lower, geoTestContext)).route.stops[0]!.id).toBe("a");
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

test("malformed saved routes, duplicate permutations and provider secrets cannot escape", async () => {
  const f = setup();
  const original = (await f.service.calculateRoute(calculate(), geoTestContext)).route;
  const changed = structuredClone(original);
  changed.distanceMeters += 1;
  const calls = f.fetch.mock.calls.length;
  await expect(f.service.updateRoute({ route: changed, changes: { type: "optimize" } }, geoTestContext)).rejects.toMatchObject({
    code: "GEO_UNSUPPORTED_OPTION",
  });
  expect(f.fetch.mock.calls.length).toBe(calls);
  for (const response of [
    (url: URL) => syntheticRouteResponse(url, { order: [0, 1, 1, 3] }),
    (url: URL) => ({ ...syntheticRouteResponse(url), secret: GEO_TEST_KEY }),
    (url: URL) => {
      const value = syntheticRouteResponse(url);
      value.results[0]!.distance = -1;
      return value;
    },
  ]) {
    const bad = setup({ response: (url) => Response.json(response(url)) });
    try {
      await bad.service.calculateRoute(calculate(), geoTestContext);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "GEO_PROVIDER_FAILED" });
      expect(JSON.stringify(error)).not.toContain(GEO_TEST_KEY);
    }
  }
});

test("conservative routing prices cover pairs, avoids, optimization and distance bands", () => {
  expect(geoRouteReferenceCost({ pairs: 3, avoids: 0, optimize: false, distanceMeters: 499999 })).toBe(3000);
  expect(geoRouteReferenceCost({ pairs: 3, avoids: 0, optimize: true, distanceMeters: 499999 })).toBe(7000);
  expect(geoRouteReferenceCost({ pairs: 25, avoids: 0, optimize: true, distanceMeters: 499999 })).toBe(265000);
  expect(geoRouteReferenceCost({ pairs: 1, avoids: 1, optimize: false, distanceMeters: 500001 })).toBe(4000);
});

test("26 stops and dense geometry fit a complete stateless update inside the capability budget", async () => {
  const f = setup({
    response: (url) => {
      const value = syntheticRouteResponse(url);
      value.results[0]!.geometry = value.results[0]!.geometry.map(([from, to]) =>
        Array.from({ length: 1800 }, (_, i) => {
          const t = i / 1799;
          return {
            lon: from!.lon + (to!.lon - from!.lon) * t,
            lat: from!.lat + (to!.lat - from!.lat) * t + (i === 0 || i === 1799 ? 0 : i % 2 ? 0.0001 : -0.0001),
          };
        }),
      );
      return Response.json(value);
    },
  });
  const result = await f.service.calculateRoute(calculate(routeStops(26)), geoTestContext);
  expect(result.route.stops).toHaveLength(26);
  expect(result.route.legs).toHaveLength(25);
  expect(result.route.simplificationToleranceMeters).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify({ data: result }))).toBeLessThanOrEqual(GEO_MAX_JSON_BYTES);
  expect(result.route.polyline6.length).toBeLessThanOrEqual(102400);
  const updated = await f.service.updateRoute({ route: result.route, changes: { type: "move", stopId: "B", toIndex: 1 } }, geoTestContext);
  expect(Buffer.byteLength(JSON.stringify({ data: updated }))).toBeLessThanOrEqual(GEO_MAX_JSON_BYTES);
  expect(updated.delta).toEqual({ distanceMeters: 0, durationSeconds: 0 });
  const calls = f.fetch.mock.calls.length;
  await expect(
    f.service.updateRoute(
      { route: result.route, changes: { type: "insert", stop: { id: "X", point: { lat: 48, lon: 10 } } } },
      geoTestContext,
    ),
  ).rejects.toMatchObject({ code: "GEO_LIMIT_EXCEEDED" });
  expect(f.fetch.mock.calls.length).toBe(calls);
});

test("larger explicit allowances settle actual credits, and update carries its new allowance", async () => {
  const f = setup({ response: (url) => Response.json(syntheticRouteResponse(url, { distances: [600000] })) });
  const result = await f.service.calculateRoute({ plan: { stops: routeStops(2), distanceAllowanceMeters: 1000000 } }, geoTestContext);
  expect(result.route.distanceAllowanceMeters).toBe(1000000);
  expect(f.used()).toBe(2000);
  const updated = await f.service.updateRoute(
    { route: result.route, changes: { type: "move", stopId: "A", toIndex: 0 }, distanceAllowanceMeters: 2000000 },
    geoTestContext,
  );
  expect(updated.route.distanceAllowanceMeters).toBe(2000000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test("insertion skips an unreachable candidate, but every failed candidate retains its known cost", async () => {
  let noRoute = false;
  const f = setup({
    response: (url) => {
      if (noRoute) {
        noRoute = false;
        return Response.json({ results: [] });
      }
      return Response.json(syntheticRouteResponse(url));
    },
  });
  const route = (await f.service.calculateRoute(calculate(routeStops(4)), geoTestContext)).route;
  noRoute = true;
  const result = await f.service.updateRoute(
    { route, changes: { type: "insert", stop: { id: "X", point: { lat: 48.015, lon: 10.015 } } } },
    geoTestContext,
  );
  expect(result.route.stops).toHaveLength(5);
  expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(f.used()).toBe(9000); // initial three pairs, then three two-pair candidate calls
});

test("completed geocoding and an unknown route timeout report separate costs", async () => {
  const f = setup({
    response: (url) => {
      if (url.pathname.includes("geocode")) return Response.json({ ...geocode, features: geocode.features.slice(0, 1) });
      throw new Error("secret-provider-cause");
    },
  });
  const stops: GeoRouteStop[] = [
    { id: "A", address: { text: "Fixture" } },
    { id: "B", address: { text: "Fixture" } },
  ];
  await expect(f.service.calculateRoute(calculate(stops), geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 1, unknownCredits: 1 } },
  });
  expect(f.used()).toBe(2000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

test("cancelled work never calls the provider; post-send cancellation retains the unknown reservation", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const before = setup();
  await expect(
    before.service.calculateRoute(calculate(routeStops(2)), { ...geoTestContext, signal: cancelled.signal }),
  ).rejects.toBeDefined();
  expect(before.fetch).not.toHaveBeenCalled();
  expect(before.reserve).not.toHaveBeenCalled();
  const controller = new AbortController();
  const after = setup({
    response: (url) => {
      controller.abort();
      return Response.json(syntheticRouteResponse(url));
    },
  });
  await expect(
    after.service.calculateRoute(calculate(routeStops(2)), { ...geoTestContext, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "GEO_PROVIDER_FAILED", details: { costs: { settledCredits: 0, unknownCredits: 1 } } });
  expect(after.used()).toBe(1000);
  expect(after.fetch).toHaveBeenCalledTimes(1);
});

test("only provably unsent routing requests retry and get refunded after the second failure", async () => {
  const f = setup({
    response: () => {
      throw Object.assign(new Error("never include this secret cause"), { code: "ECONNREFUSED" });
    },
  });
  await expect(f.service.calculateRoute(calculate(routeStops(2)), geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 0, unknownCredits: 0 } },
  });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.used()).toBe(0);
});

test("a known route distance is charged even if malformed geometry prevents a result", async () => {
  const f = setup({
    response: (url) => {
      const value = syntheticRouteResponse(url, { distances: [1600000] });
      value.results[0]!.geometry = [];
      return Response.json(value);
    },
  });
  await expect(f.service.calculateRoute(calculate(routeStops(2)), geoTestContext)).rejects.toMatchObject({
    code: "GEO_PROVIDER_FAILED",
    details: { costs: { settledCredits: 4, unknownCredits: 0 } },
  });
  expect(f.used()).toBe(4000);
});

test("unattainable whole-chain reservations return an actionable total-limit error before admission", async () => {
  for (const plan of [{ stops: routeStops(26) }, { stops: routeStops(8), optimize: true }]) {
    const f = setup({ daily: 300 });
    await expect(f.service.calculateRoute({ plan }, geoTestContext)).rejects.toMatchObject({
      code: "GEO_LIMIT_EXCEEDED",
      details: { limit: "reservationCredits", max: 300, actual: plan.optimize ? 301 : 625 },
    });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  }
});

test("optimization preflight uses an order-independent bound and checks overrides only in the new order", async () => {
  const ordered = [0, 3, 2, 1, 4].map((position, i) => ({ id: String.fromCharCode(65 + i), point: { lat: 0, lon: position * 0.09 } }));
  const f = setup({
    response: (url) =>
      Response.json(syntheticRouteResponse(url, url.searchParams.get("optimize_stops") === "true" ? { order: [0, 3, 2, 1, 4] } : {})),
  });
  const options = [{ fromStopId: "A", toStopId: "B", options: { avoid: ["ferries" as const] } }];
  const result = await f.service.calculateRoute(
    { plan: { stops: ordered, optimize: true, distanceAllowanceMeters: 20000, legOptions: options } },
    geoTestContext,
  );
  expect(result.route.stops.map((stop) => stop.id)).toEqual(["A", "D", "C", "B", "E"]);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  const original = await f.service.calculateRoute({ plan: { stops: ordered, legOptions: options } }, geoTestContext);
  const updated = await f.service.updateRoute(
    { route: original.route, changes: { type: "optimize" }, distanceAllowanceMeters: 20000 },
    geoTestContext,
  );
  expect(updated.after.stopIds).toEqual(["A", "D", "C", "B", "E"]);
});

test("impossible optimized lower bounds reject with zero provider calls", async () => {
  const f = setup();
  await expect(
    f.service.calculateRoute(
      {
        plan: {
          stops: [
            { id: "A", point: { lat: 0, lon: 0 } },
            { id: "B", point: { lat: 0, lon: 1 } },
            { id: "C", point: { lat: 0, lon: 2 } },
          ],
          optimize: true,
          distanceAllowanceMeters: 20000,
        },
      },
      geoTestContext,
    ),
  ).rejects.toMatchObject({ code: "GEO_LIMIT_EXCEEDED" });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});

test("unrepresentable provider pricing retains the allocation as unknown and stops later paid steps", async () => {
  for (const malformed of [false, true]) {
    const f = setup({
      response: (url) => {
        const response = syntheticRouteResponse(url, { distances: [1e20] });
        if (malformed) response.results[0]!.geometry = [];
        return Response.json(response);
      },
    });
    await expect(
      f.service.calculateRoute(
        { plan: { stops: routeStops(3), legOptions: [{ fromStopId: "B", toStopId: "C", options: { mode: "walk" } }] } },
        geoTestContext,
      ),
    ).rejects.toMatchObject({
      code: "GEO_PROVIDER_FAILED",
      details: { costs: { settledCredits: 0, unknownCredits: 1 } },
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.used()).toBe(1000);
  }
});

test("a valid overrun is cached and a larger explicit allowance reuses it without paying again", async () => {
  const memory = new Map<string, string>();
  const redis: GeoRedis = {
    send: async (command, args) => (command === "GET" ? (memory.get(args[0]!) ?? null) : (memory.set(args[0]!, args[1]!), "OK")),
  };
  const f = setup({
    cache: createGeoCache(async () => redis),
    response: (url) => Response.json(syntheticRouteResponse(url, { distances: [1600000] })),
  });
  await expect(f.service.calculateRoute(calculate(routeStops(2)), geoTestContext)).rejects.toMatchObject({ code: "GEO_COST_OVERRUN" });
  const retried = await f.service.calculateRoute({ plan: { stops: routeStops(2), distanceAllowanceMeters: 2000000 } }, geoTestContext);
  expect(retried.route.distanceMeters).toBe(1600000);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.used()).toBe(4000);
  expect(f.settle.mock.calls.at(-1)![1]).toBe(0);
});

test("raw provider geometry may exceed the public line bound and is compacted before returning", async () => {
  const f = setup({
    response: (url) => {
      const value = syntheticRouteResponse(url),
        result = value.results[0]!;
      const [from, to] = result.geometry[0]!;
      const line = Array.from({ length: 60000 }, (_, i) => ({
        lon: from!.lon + ((to!.lon - from!.lon) * i) / 59999,
        lat: from!.lat + ((to!.lat - from!.lat) * i) / 59999 + (i === 0 || i === 59999 ? 0 : i % 2 ? 0.002 : -0.002),
      }));
      const polyline6 = encodeGeoTestLine(line);
      expect(polyline6.length).toBeGreaterThan(102400);
      return Response.json({ results: [{ ...result, geometry: [line] }] });
    },
  });
  const result = await f.service.calculateRoute(calculate(routeStops(2)), geoTestContext);
  expect(GeoRouteSchema.safeParse(result.route).success).toBeTrue();
  expect(result.route.polyline6.length).toBeLessThanOrEqual(102400);
  expect(Buffer.byteLength(JSON.stringify({ data: result }))).toBeLessThanOrEqual(GEO_MAX_JSON_BYTES);
});

test("documented JSON waypoint locations may differ from geometry endpoints without an invented snap threshold", async () => {
  const f = setup({
    response: (url) => {
      const value = syntheticRouteResponse(url, { order: [0, 2, 1, 3] });
      for (const waypoint of value.results[0]!.waypoints) waypoint.location[0]! += 0.001;
      return Response.json(value);
    },
  });
  const result = await f.service.calculateRoute({ plan: { stops: routeStops(4), optimize: true } }, geoTestContext);
  expect(result.route.stops.map((stop) => stop.id)).toEqual(["A", "C", "B", "D"]);
  expect(f.used()).toBe(7000);
});

test("failed overrun settlement exposes retained reservation and all unreconciled reference costs separately", async () => {
  const f = setup({ response: (url) => Response.json(syntheticRouteResponse(url, { distances: [1600000] })) });
  f.settle.mockRejectedValueOnce(new Error("private-database-cause"));
  try {
    await f.service.calculateRoute(calculate(routeStops(2)), geoTestContext);
    throw new Error("Expected accounting failure");
  } catch (error) {
    expect(error).toMatchObject({
      code: "GEO_PROVIDER_FAILED",
      details: {
        costs: { settledCredits: 0, unknownCredits: 1 },
        accounting: { reservationCredits: 1, knownReferenceCredits: 4, unknownReferenceCredits: 0 },
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-database-cause");
    if (error && typeof error === "object" && "details" in error && "code" in error)
      expect(GeoErrorDetailsSchema.parse({ code: error.code, ...Object(error.details) }).code).toBe("GEO_PROVIDER_FAILED");
  }
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.used()).toBe(1000);
});
