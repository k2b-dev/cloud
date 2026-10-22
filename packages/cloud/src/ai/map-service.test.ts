import { describe, expect, test } from "bun:test";
import { mapAddress, mapAvailability, mapFixture, mapGeoFixture, mapPlaces, mapSuccess, mapTime } from "./map.test-fixture";
import { AiMapToolInputSchema, aiMapToolResult } from "./map-contracts";
import { aiMapNotebookContent } from "./map-notebook";
import { applyAiMap, createAiMap } from "./map-service";

const context = () => {
  const f = mapGeoFixture();
  return { ...f, ctx: { geo: f.geo, caller: {}, now: () => new Date(mapTime), verifyWeb: async () => true } };
};
describe("native Assistant map transitions", () => {
  test("unconfigured snapshot never geocodes, searches or routes", async () => {
    const f = context();
    f.geo.availability = async () => mapSuccess({ ...mapAvailability, configured: false });
    const result = await createAiMap(
      { conversationId: "aBc123", command: { type: "places", search: { title: "Museen in Ulm", categories: ["museum"], near: "Ulm" } } },
      f.ctx,
    );
    expect(result.map.issue?.code).toBe("GEO_NOT_CONFIGURED");
    expect(f.calls).toEqual([]);
  });
  test.each(["person", "cloud"] as const)("exhausted %s allowance stops before provider", async (scope) => {
    const f = context();
    f.geo.availability = async () => mapSuccess({ ...mapAvailability, [scope]: { ...mapAvailability[scope], exhausted: true } });
    const result = await applyAiMap(
      { map: mapFixture() },
      { type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } },
      f.ctx,
    );
    expect(result.map.issue).toEqual({ code: "GEO_BUDGET_EXHAUSTED", scope, resetsAt: mapAvailability[scope].resetsAt });
    expect(f.calls).toEqual([]);
  });
  test("prepared loading snapshot is durable before first provider call", async () => {
    const f = context();
    let prepared = false;
    f.geo.geocode = async () => {
      expect(prepared).toBe(true);
      return mapSuccess({ address: mapAddress(), provenance: mapAddress().provenance });
    };
    const result = await createAiMap(
      { conversationId: "aBc123", command: { type: "places", search: { title: "Museen", categories: ["museum"], near: "Ulm" } } },
      {
        ...f.ctx,
        onPrepared: async (value) => {
          expect(value.map.pending).toBe(true);
          expect(value.retry?.type).toBe("places");
          prepared = true;
        },
      },
    );
    expect(result.map.revision).toBe(2);
    expect(result.map.pending).toBeUndefined();
    expect(result.map.groups[0]?.places.length).toBe(4);
  });
  test("follow-up adds server results in a second group; description needs a read source", async () => {
    const f = context();
    const original = mapFixture();
    const next = await applyAiMap(
      { map: original },
      { type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } },
      f.ctx,
    );
    expect(next.map.id).toBe(original.id);
    expect(next.map.groups[0]).toEqual(original.groups[0]);
    expect(next.map.groups[1]?.places).toEqual(mapPlaces(4, "cafe"));
    expect(original.revision).toBe(1);
    await expect(
      applyAiMap(
        next,
        { type: "describe", web: [{ placeId: "museum-0", url: "https://invented.example/", description: "Fake" }] },
        { ...f.ctx, verifyWeb: async () => false },
      ),
    ).rejects.toThrow("MAP_WEB_SOURCE_NOT_READ");
  });
  test("model input cannot supply POI coordinates or provider route geometry", () => {
    expect(
      AiMapToolInputSchema.safeParse({
        command: { type: "places", search: { title: "Fake", categories: ["cafe"], near: "Ulm", point: { lat: 1, lon: 2 } } },
      }).success,
    ).toBe(false);
    for (const stops of [
      [{ id: "a" }, { id: "b", address: "Ulm" }],
      [
        { id: "a", address: "Ulm", placeId: "1" },
        { id: "b", address: "Blaubeuren" },
      ],
      [
        { id: "a", address: "Ulm" },
        { id: "a", address: "Blaubeuren" },
      ],
    ])
      expect(AiMapToolInputSchema.safeParse({ command: { type: "route", title: "Invalid", stops } }).success).toBe(false);
    expect(
      AiMapToolInputSchema.safeParse({
        command: {
          type: "route",
          title: "Fake",
          stops: [
            { id: "a", point: { lat: 1, lon: 2 } },
            { id: "b", point: { lat: 3, lon: 4 } },
          ],
        },
      }).success,
    ).toBe(false);
  });
  test("model marks cannot collide with provider IDs and browser retry retains the reference mode", async () => {
    const f = context();
    const original = mapFixture();
    original.groups[0]!.places[1]!.id = "1";
    const web = [{ placeId: "1", url: "https://source.example/", description: "Read source" }];
    const described = await applyAiMap({ map: original }, { type: "describe", web }, { ...f.ctx, placeReferences: "marks" });
    expect(described.map.web.at(-1)?.placeId).toBe("museum-0");
    expect(web[0]!.placeId).toBe("1");
    let fail = true;
    f.geo.searchPlaces = async (input) => {
      expect(input.area).toEqual({ type: "circle", point: original.groups[0]!.places[0]!.point, radiusMeters: 2000 });
      expect(input.name).toBe("Café");
      return fail
        ? { ok: false, error: { code: "GEO_PROVIDER_FAILED", status: 502, message: "failed" } }
        : mapSuccess({ places: [], provenance: mapAddress().provenance });
    };
    const command = { type: "search" as const, search: { title: "Cafés", categories: ["cafe" as const], placeId: "1", name: "Café" } };
    const failed = await applyAiMap({ map: original }, command, { ...f.ctx, placeReferences: "marks" });
    fail = false;
    const retry = await applyAiMap(failed, { type: "retry" }, f.ctx);
    expect(retry.map.issue).toBeUndefined();
  });
  test("insert selection reaches actual delta; discard keeps original; accept and timestamped undo call no provider", async () => {
    const f = context();
    const original = mapFixture("route");
    original.picker = mapPlaces(5);
    const preview = await applyAiMap({ map: original }, { type: "preview", change: { type: "insert", placeId: "museum-3" } }, f.ctx);
    expect(preview.map.preview?.result.delta).toEqual({ distanceMeters: 4000, durationSeconds: 720 });
    expect(preview.map.preview?.result.route.stops[2]?.point).toEqual(mapPlaces(5)[3]!.point);
    expect(preview.map.route).toEqual(original.route);
    const discarded = await applyAiMap(preview, { type: "discard" }, f.ctx);
    expect(discarded.map.route).toEqual(original.route);
    expect(discarded.map.preview).toBeUndefined();
    const calls = f.calls.length;
    const accepted = await applyAiMap(preview, { type: "accept" }, f.ctx);
    expect(accepted.map.route?.stops).toHaveLength(5);
    expect(accepted.map.receipt?.at).toBe(mapTime);
    const undone = await applyAiMap(accepted, { type: "undo" }, f.ctx);
    expect(undone.map.route).toEqual(original.route);
    expect(undone.map.undo).toBeUndefined();
    expect(f.calls.length).toBe(calls);
  });
  test("ambiguity candidates are preserved and selected server address is used before route calculation", async () => {
    const f = context();
    f.geo.calculateRoute = async () => ({
      ok: false,
      error: {
        code: "GEO_ADDRESS_AMBIGUOUS",
        status: 409,
        message: "Ambiguous",
        details: { stopId: "b", candidates: [mapAddress(0), mapAddress(1)] },
      },
    });
    const result = await createAiMap(
      {
        conversationId: "aBc123",
        command: {
          type: "route",
          title: "Tour",
          stops: [
            { id: "a", address: "Ulm" },
            { id: "b", address: "Blaubeuren" },
          ],
        },
      },
      f.ctx,
    );
    expect(result.map.candidates).toHaveLength(2);
    expect(result.map.route).toBeUndefined();
    f.geo.calculateRoute = async (input) => {
      expect(input.plan.stops[1]?.point).toEqual(mapAddress(1).point);
      return mapSuccess({ route: mapFixture("route").route! });
    };
    const selected = await applyAiMap(result, { type: "choose", index: 1 }, f.ctx);
    expect(selected.map.candidates).toBeUndefined();
    expect(selected.map.route).toBeDefined();
  });
  test("per-leg preferences and corridor km window reach the public Geo seam unchanged", async () => {
    const f = context();
    const original = mapFixture("route");
    f.geo.updateRoute = async (input) => {
      expect(input.changes).toEqual({
        type: "options",
        options: { mode: "car", avoid: ["highways"] },
        leg: { fromStopId: "stop-1", toStopId: "stop-2" },
      });
      return mapGeoFixture().geo.updateRoute(input, {});
    };
    await applyAiMap(
      { map: original },
      {
        type: "preview",
        change: { type: "options", options: { mode: "car", avoid: ["highways"] }, leg: { fromStopId: "stop-1", toStopId: "stop-2" } },
      },
      f.ctx,
    );
    f.geo.searchPlaces = async (input) => {
      expect(input.along).toEqual({ polyline6: original.route!.polyline6, fromKm: 40, toKm: 80 });
      return mapSuccess({ places: [], provenance: mapAddress().provenance });
    };
    const searched = await applyAiMap(
      { map: original },
      { type: "search", search: { title: "Unterwegs", categories: ["restaurant"], along: { fromKm: 40, toKm: 80 } } },
      f.ctx,
    );
    expect(searched.map.groups).toHaveLength(1);
  });
  test("provider failure keeps data and retry; cost overrun is never automatically retried", async () => {
    const f = context();
    const original = mapFixture("route");
    f.geo.updateRoute = async () => ({
      ok: false,
      error: { code: "GEO_COST_OVERRUN", status: 429, message: "overrun", details: { costs: { settledCredits: 20, unknownCredits: 0 } } },
    });
    const result = await applyAiMap({ map: original }, { type: "preview", change: { type: "optimize" } }, f.ctx);
    expect(result.map.route).toEqual(original.route);
    expect(result.map.issue?.code).toBe("GEO_COST_OVERRUN");
    expect(result.retry?.type).toBe("preview");
    const calls = f.calls.length;
    await expect(applyAiMap(result, { type: "retry" }, f.ctx)).rejects.toThrow("MAP_NEW_ALLOWANCE_REQUIRED");
    await expect(applyAiMap(result, { type: "retry", distanceAllowanceMeters: 500000 }, f.ctx)).rejects.toThrow(
      "MAP_NEW_ALLOWANCE_REQUIRED",
    );
    expect(f.calls.length).toBe(calls);
    const local = await applyAiMap(result, { type: "discard" }, f.ctx);
    expect(local.map.issue?.code).toBe("GEO_COST_OVERRUN");
    await expect(applyAiMap(local, { type: "preview", change: { type: "optimize" } }, f.ctx)).rejects.toThrow("MAP_NEW_ALLOWANCE_REQUIRED");
    const described = await applyAiMap(local, { type: "describe", web: [] }, f.ctx);
    await expect(applyAiMap(described, { type: "retry" }, f.ctx)).rejects.toThrow();
    const retried = await applyAiMap(result, { type: "retry", distanceAllowanceMeters: 600000 }, f.ctx);
    expect(retried.map.issue?.code).toBe("GEO_COST_OVERRUN");
  });
  test("tool transport omits route geometry and undo snapshots", () => {
    const map = mapFixture("route");
    map.undo = { route: map.route!, title: "Undo" };
    const result = aiMapToolResult(map, true);
    expect(JSON.stringify(result)).not.toContain("polyline6");
    expect(JSON.stringify(result).length).toBeLessThan(8000);
    expect(result.map.id).toBe(map.id);
  });
  test("current location uses a verified destination and the same budget preflight", async () => {
    const f = context();
    f.geo.availability = async () => mapSuccess({ ...mapAvailability, configured: false });
    const before = mapFixture();
    const next = await applyAiMap({ map: before }, { type: "location", destinationId: "museum-0", point: { lat: 48, lon: 10 } }, f.ctx);
    expect(next.map.issue?.code).toBe("GEO_NOT_CONFIGURED");
    expect(f.calls).toEqual([]);
  });
  test("full-length provider names keep route actions and previews within the saved title contract", async () => {
    const f = context();
    const places = mapFixture();
    const place = places.groups[0]!.places[0]!;
    place.name = "M".repeat(300);
    const routed = await applyAiMap({ map: places }, { type: "location", destinationId: place.id, point: { lat: 48, lon: 10 } }, f.ctx);
    expect(routed.map.title).toHaveLength(160);
    const preview = await applyAiMap(
      { map: { ...mapFixture("route"), picker: [place] } },
      { type: "preview", change: { type: "insert", placeId: place.id } },
      f.ctx,
    );
    expect(preview.map.preview?.title).toHaveLength(160);
    expect(preview.map.preview?.changes).toMatchObject({ stop: { label: place.name } });
  });
  test("Notebook serialization uses shared schema and retains every group and complete route", () => {
    const map = mapFixture();
    map.groups.push({ title: "Cafés", places: mapPlaces(20, "cafe") });
    map.route = mapFixture("route").route;
    map.groups[0]!.places[0]!.website = "https://[";
    const providerId = "provider-" + "a".repeat(1000);
    map.groups[0]!.places[0]!.id = providerId;
    const unicodeWebsite = `https://example.com/${"ä".repeat(400)}`;
    map.groups[0]!.places[1]!.website = unicodeWebsite;
    const markdown = aiMapNotebookContent(map);
    expect(markdown).not.toContain("https://[");
    expect(markdown).toContain(`"id":"${providerId}"`);
    expect(markdown).toContain(unicodeWebsite);
    expect(markdown.match(/:::map/g)).toHaveLength(3);
    expect(markdown).toContain('"distanceAllowanceMeters":500000');
    expect(markdown).toContain('"computedAt":"2026-10-19T14:31:00.000Z"');
  });
});

test.each([false, true])("map named search reaches public Geo and survives lastSearch, corridor=%s", async (corridor) => {
  const f = context();
  const original = mapFixture(corridor ? "route" : "places");
  const search = {
    title: "Wasserfall",
    categories: ["attraction"],
    name: " Wasserfall ",
    ...(corridor ? { along: { fromKm: 0, toKm: 10 } } : { near: "Ulm" }),
  };
  const command = AiMapToolInputSchema.parse({ command: { type: "search", search } }).command;
  let called = false;
  f.geo.searchPlaces = async (input) => {
    called = true;
    expect(input.name).toBe("Wasserfall");
    expect(input.categories).toEqual(["attraction"]);
    expect(Boolean(input.along)).toBe(corridor);
    if (!corridor) {
      expect(input.area?.type).toBe("circle");
      expect(input.near).toBeUndefined();
    }
    return mapSuccess({ places: [], provenance: mapAddress().provenance });
  };
  const result = await applyAiMap({ map: original }, command, f.ctx);
  expect(called).toBe(true);
  expect(result.map.lastSearch?.name).toBe("Wasserfall");
  for (const name of [" ", "x".repeat(301)])
    expect(AiMapToolInputSchema.safeParse({ command: { type: "search", search: { ...search, name } } }).success).toBe(false);
});
