import { describe, expect, test } from "bun:test";
import { mapAddress, mapAvailability, mapFixture, mapGeoFixture, mapPlaces, mapSuccess, mapTime } from "./map.test-fixture";
import { AI_MAP_MAX_DETAILS, AiMapSchema, AiMapToolInputSchema, aiMapToolResult } from "./map-contracts";
import { applyAiMap, createAiMap } from "./map-service";

const context = () => {
  const f = mapGeoFixture();
  return { ...f, ctx: { geo: f.geo, caller: {}, now: () => new Date(mapTime), verifyWeb: async () => true } };
};
describe("native Assistant map transitions", () => {
  test("details replace each ID, keep the latest duplicate and leave web and input untouched", async () => {
    const f = context();
    const original = mapFixture();
    original.details = [
      { id: "museum-0", note: "Old", source: { label: "Old source" } },
      { id: "museum-1", note: "Keep" },
    ];
    const details = [
      { id: "museum-0", note: "First" },
      { id: "museum-0", note: "Newest" },
    ];
    const next = await applyAiMap({ map: original }, { type: "describe", details }, f.ctx);
    expect(next.map.details).toEqual([
      { id: "museum-1", note: "Keep" },
      { id: "museum-0", note: "Newest" },
    ]);
    expect(next.map.web).toEqual(original.web);
    expect(original.details[0]?.note).toBe("Old");
    expect(details[0]?.note).toBe("First");
    expect(f.calls).toEqual([]);
    const both = await applyAiMap(
      next,
      {
        type: "describe",
        web: [{ placeId: "museum-0", description: "Read", url: "https://source.example/" }],
        details: [{ id: "museum-0", source: { label: "New source", icon: "file-text" } }],
      },
      f.ctx,
    );
    expect(both.map.web[0]?.description).toBe("Read");
    expect(both.map.details?.at(-1)).toEqual({ id: "museum-0", source: { label: "New source", icon: "file-text" } });
  });
  test("details resolve exact places, numbered/lettered/picker marks and stable stop IDs", async () => {
    const f = context();
    const original = mapFixture();
    original.groups[0]!.places[1]!.id = "1";
    original.groups.push({ title: "Cafés", places: mapPlaces(2, "cafe") });
    original.picker = mapPlaces(2, "pick");
    original.route = mapFixture("route").route;
    const details = ["1", "A", "pick-1", "stop-1"].map((id) => ({ id, note: id }));
    const next = await applyAiMap({ map: original }, { type: "describe", details }, { ...f.ctx, placeReferences: "marks" });
    expect(next.map.details?.map((item) => item.id)).toEqual(["museum-0", "cafe-0", "pick-0", "stop-1"]);
    expect(details.map((item) => item.id)).toEqual(["1", "A", "pick-1", "stop-1"]);
    const exact = await applyAiMap(next, { type: "describe", details: [{ id: "1", note: "Exact" }] }, f.ctx);
    expect(exact.map.details?.at(-1)?.id).toBe("1");
    await expect(applyAiMap(next, { type: "describe", details: [{ id: "missing" }] }, f.ctx)).rejects.toThrow("MAP_PLACE_NOT_FOUND");
    await expect(
      applyAiMap(next, { type: "describe", details: [{ id: "museum-0" }] }, { ...f.ctx, placeReferences: "marks" }),
    ).rejects.toThrow("MAP_PLACE_NOT_FOUND");
  });
  test("the detail bound covers every place, picked result and stop at once, so live details are never evicted", async () => {
    const f = context();
    const map = mapFixture();
    map.groups = [
      { title: "First", places: mapPlaces(20) },
      { title: "Second", places: mapPlaces(20, "cafe") },
    ];
    const route = mapFixture("route").route!;
    route.stops = Array.from({ length: 26 }, (_, i) => ({ ...route.stops[i % 4]!, id: `stop-${i}` }));
    route.legs = route.stops.slice(1).map((stop, i) => ({ ...route.legs[i % 3]!, fromStopId: route.stops[i]!.id, toStopId: stop.id }));
    map.route = route;
    map.picker = mapPlaces(5, "picker");
    // A stale entry from an earlier search must not take a live entry's room.
    map.details = [
      { id: "gone-0", note: "Stale" },
      ...[...map.groups.flatMap((g) => g.places), ...route.stops].map(({ id }) => ({ id, note: "Old" })),
    ];
    const next = await applyAiMap(
      { map },
      { type: "describe", details: [{ id: "museum-0", note: "Newest" }, ...map.picker.map(({ id }) => ({ id }))] },
      f.ctx,
    );
    expect(AI_MAP_MAX_DETAILS).toBe(71);
    expect(next.map.details).toHaveLength(AI_MAP_MAX_DETAILS);
    expect(next.map.details?.some((item) => item.id === "gone-0")).toBe(false);
    expect(next.map.details?.find((item) => item.id === "museum-1")).toEqual({ id: "museum-1", note: "Old" });
    expect(next.map.details?.slice(-6)).toEqual([{ id: "museum-0", note: "Newest" }, ...map.picker.map(({ id }) => ({ id }))]);
  });
  test("a new route replaces stop details even where it reuses a stop id; a changed address drops its stop's details", async () => {
    const f = context();
    f.geo.calculateRoute = async () => ({
      ok: false,
      error: { code: "GEO_ADDRESS_AMBIGUOUS", status: 409, message: "Choose", details: { stopId: "b", candidates: [mapAddress()] } },
    });
    const route = (b: string) => ({
      type: "route" as const,
      title: "Tour",
      stops: [
        { id: "a", address: "Ulm" },
        { id: "b", address: b },
      ],
    });
    const first = await applyAiMap({ map: mapFixture() }, { ...route("Blaubeuren"), details: [{ id: "b", note: "Main entrance" }] }, f.ctx);
    expect(first.map.details).toEqual([{ id: "b", note: "Main entrance" }]);
    const replaced = await applyAiMap(first, route("München"), f.ctx);
    expect(replaced.map.details ?? []).toEqual([]);
    const described = await applyAiMap(replaced, { type: "describe", details: [{ id: "a", note: "Start" }] }, f.ctx);
    const repaired = await applyAiMap(described, { type: "repair", stopId: "a", address: "Neu-Ulm" }, f.ctx);
    expect(repaired.map.details ?? []).toEqual([]);
  });
  test("an id that names both a stop and a place mark is rejected instead of guessed", async () => {
    const f = context();
    const map = mapFixture();
    map.route = mapFixture("route").route;
    map.route!.stops[1] = { ...map.route!.stops[1]!, id: "1" };
    await expect(
      applyAiMap({ map }, { type: "describe", details: [{ id: "1", note: "Which?" }] }, { ...f.ctx, placeReferences: "marks" }),
    ).rejects.toThrow("MAP_DETAIL_ID_AMBIGUOUS");
  });
  test("a new route with an unread link fails before the map is announced", async () => {
    const f = context();
    let prepared = 0;
    await expect(
      createAiMap(
        {
          conversationId: "c1",
          command: {
            type: "route",
            title: "Tour",
            stops: [
              { id: "a", address: "Ulm" },
              { id: "b", address: "Blaubeuren" },
            ],
            details: [{ id: "b", links: [{ label: "Order", url: "https://unread.example/order" }] }],
          },
        },
        {
          ...f.ctx,
          verifyWeb: async () => false,
          onPrepared: async () => {
            prepared++;
          },
        },
      ),
    ).rejects.toThrow("MAP_WEB_SOURCE_NOT_READ");
    expect(prepared).toBe(0);
  });
  test.each(["search", "places"] as const)("%s drops details for replaced groups while retaining live stops and places", async (type) => {
    const f = context();
    const map = mapFixture();
    map.groups.push({ title: "Old", places: mapPlaces(2, "old") });
    map.route = mapFixture("route").route;
    map.details = [
      { id: "museum-0", note: "Original" },
      { id: "old-0", note: "Stale" },
      { id: "stop-0", note: "Stop" },
    ];
    const next = await applyAiMap({ map }, { type, search: { title: "New", categories: ["cafe"], near: "Ulm" } }, f.ctx);
    expect(next.map.details).toEqual([
      ...(type === "search" ? [{ id: "museum-0", note: "Original" }] : []),
      { id: "stop-0", note: "Stop" },
    ]);
  });
  test("replacing a picker drops its details and discarding it retains group details", async () => {
    const f = context();
    const map = mapFixture("route");
    map.groups = mapFixture().groups;
    map.picker = mapPlaces(1, "old");
    map.details = [{ id: "old-0" }, { id: "museum-0" }];
    const next = await applyAiMap(
      { map },
      { type: "search", insert: true, search: { title: "Stops", categories: ["cafe"], near: "Ulm" } },
      f.ctx,
    );
    expect(next.map.details).toEqual([{ id: "museum-0" }]);
    const described = await applyAiMap(next, { type: "describe", details: [{ id: "cafe-0", note: "Candidate" }] }, f.ctx);
    const discarded = await applyAiMap(described, { type: "discard" }, f.ctx);
    expect(discarded.map.details).toEqual([{ id: "museum-0" }]);
  });
  test("route details survive unresolved plans and stale stops disappear on replacement", async () => {
    const f = context();
    f.geo.calculateRoute = async () => ({
      ok: false,
      error: { code: "GEO_ADDRESS_AMBIGUOUS", status: 409, message: "Choose", details: { stopId: "b", candidates: [mapAddress()] } },
    });
    const map = mapFixture();
    map.plan = {
      stops: [
        { id: "old-a", address: { text: "Old start" } },
        { id: "old-b", address: { text: "Old end" } },
      ],
    };
    map.details = [
      { id: "old-a", note: "Stale" },
      { id: "museum-0", note: "Keep" },
    ];
    const command = {
      type: "route" as const,
      title: "Tour",
      stops: [
        { id: "a", address: "Ulm" },
        { id: "b", address: "Blaubeuren" },
      ],
      details: [{ id: "b", note: "Meet here" }],
    };
    const next = await applyAiMap({ map }, command, f.ctx);
    expect(next.map.issue?.code).toBe("GEO_ADDRESS_AMBIGUOUS");
    expect(next.map.details).toEqual([
      { id: "museum-0", note: "Keep" },
      { id: "b", note: "Meet here" },
    ]);
    const described = await applyAiMap(next, { type: "describe", details: [{ id: "a", note: "Start" }] }, f.ctx);
    expect(described.map.details?.at(-1)).toEqual({ id: "a", note: "Start" });
    await expect(applyAiMap({ map }, { ...command, details: [{ id: "museum-0" }] }, f.ctx)).rejects.toThrow("MAP_STOP_NOT_FOUND");
  });
  test("route details attach to resolved stops and undo drops details of removed inserted stops", async () => {
    const f = context();
    const original = mapFixture();
    const routed = await applyAiMap(
      { map: original },
      {
        type: "route",
        title: "Tour",
        stops: mapFixture("route").route!.stops.map((stop) => ({ id: stop.id, address: stop.label! })),
        details: [{ id: "stop-1", note: "Keep with stop" }],
      },
      f.ctx,
    );
    expect(routed.map.details).toEqual([{ id: "stop-1", note: "Keep with stop" }]);
    routed.map.plan = { stops: routed.map.route!.stops };
    const preview = await applyAiMap(routed, { type: "preview", change: { type: "insert", placeId: "museum-0" } }, f.ctx);
    const accepted = await applyAiMap(preview, { type: "accept" }, f.ctx);
    const insertedId = accepted.map.route!.stops[2]!.id;
    const described = await applyAiMap(accepted, { type: "describe", details: [{ id: insertedId, note: "Inserted" }] }, f.ctx);
    described.map.plan = { stops: described.map.route!.stops };
    const undone = await applyAiMap(described, { type: "undo" }, f.ctx);
    expect(undone.map.details).toEqual([{ id: "stop-1", note: "Keep with stop" }]);
  });
  test("route details reject unread external links before paid route calculation", async () => {
    const f = context();
    await expect(
      applyAiMap(
        { map: mapFixture() },
        {
          type: "route",
          title: "Tour",
          stops: [
            { id: "a", address: "Ulm" },
            { id: "b", address: "Blaubeuren" },
          ],
          details: [{ id: "b", links: [{ label: "Website", url: "https://unread.example/" }] }],
        },
        { ...f.ctx, verifyWeb: async () => false },
      ),
    ).rejects.toThrow("MAP_WEB_SOURCE_NOT_READ");
    expect(f.calls).toEqual(["availability"]);
  });
  test("detail links verify every external URL but never fetch same-origin Cloud paths", async () => {
    const f = context();
    const verified: string[] = [];
    const links = [
      { label: "Open", url: "/app/example/items/1?tab=details#note" },
      { label: "HTTPS", url: "https://source.example/" },
      { label: "HTTP", url: "http://source.example/" },
    ];
    const next = await applyAiMap(
      { map: mapFixture() },
      { type: "describe", details: [{ id: "museum-0", links }] },
      {
        ...f.ctx,
        verifyWeb: async (url) => {
          verified.push(url);
          return true;
        },
      },
    );
    expect(verified).toEqual(links.slice(1).map((link) => link.url));
    expect(next.map.details?.[0]?.links).toEqual(links);
    expect(f.calls).toEqual([]);
    await expect(
      applyAiMap(next, { type: "describe", details: [{ id: "museum-0", links: [links[1]!] }] }, { ...f.ctx, verifyWeb: async () => false }),
    ).rejects.toThrow("MAP_WEB_SOURCE_NOT_READ");
    const local = await applyAiMap(
      next,
      { type: "describe", details: [{ id: "museum-0", links: [links[0]!] }] },
      {
        ...f.ctx,
        verifyWeb: async () => {
          throw new Error("Must not fetch");
        },
      },
    );
    expect(local.map.details?.[0]?.links).toEqual([links[0]!]);
  });
  test.each([
    "//outside.example/",
    "/\\outside.example/",
    "/\n/outside.example/",
    "/\t/outside.example/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "mailto:test@example.com",
    "relative/path",
    "https:example.com",
    "https://[",
  ])("rejects unsupported detail link %s before verification", async (url) => {
    const f = context();
    const original = mapFixture();
    await expect(
      applyAiMap(
        { map: original },
        { type: "describe", details: [{ id: "museum-0", links: [{ label: "Open", url }] }] },
        {
          ...f.ctx,
          verifyWeb: async () => {
            throw new Error("Must not fetch");
          },
        },
      ),
    ).rejects.toThrow("MAP_DETAIL_LINK_INVALID");
    expect(original.details).toBeUndefined();
  });
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
    expect(result.map.issue?.costs).toEqual({ settledCredits: 20, unknownCredits: 0 });
    expect(result.retry?.type).toBe("preview");
    const calls = f.calls.length;
    await expect(applyAiMap(result, { type: "retry" }, f.ctx)).rejects.toThrow("MAP_CONFIRM_RETRY_REQUIRED");
    expect(
      AiMapToolInputSchema.safeParse({ mapId: original.id, revision: 1, command: { type: "retry", distanceAllowanceMeters: 600000 } })
        .success,
    ).toBe(false);
    expect(f.calls.length).toBe(calls);
    const local = await applyAiMap(result, { type: "discard" }, f.ctx);
    expect(local.map.issue?.code).toBe("GEO_COST_OVERRUN");
    await expect(applyAiMap(local, { type: "preview", change: { type: "optimize" } }, f.ctx)).rejects.toThrow("MAP_CONFIRM_RETRY_REQUIRED");
    const described = await applyAiMap(local, { type: "describe", web: [] }, f.ctx);
    await expect(applyAiMap(described, { type: "retry" }, f.ctx)).rejects.toThrow();
    const retried = await applyAiMap(result, { type: "retry" }, { ...f.ctx, allowCostOverrunRetry: true });
    expect(retried.map.issue?.code).toBe("GEO_COST_OVERRUN");
  });
  test.each([
    { code: "GEO_BUDGET_EXHAUSTED", details: { requiredCredits: 40, availableCredits: 12, shortfallCredits: 28 } },
    { code: "GEO_LIMIT_EXCEEDED", details: { limit: "reservationCredits", actual: 40, max: 12 } },
  ])("route budget refusal preserves its numeric shortfall: $code", async ({ code, details }) => {
    const f = context();
    f.geo.updateRoute = async () => ({ ok: false, error: { code, status: 429, message: "budget", details } });
    const result = await applyAiMap({ map: mapFixture("route") }, { type: "preview", change: { type: "optimize" } }, f.ctx);
    expect(result.map.issue).toMatchObject({ code, requiredCredits: 40, availableCredits: 12, shortfallCredits: 28 });
  });
  test("an overdrawn concurrent budget keeps its signed balance and shortfall", async () => {
    const f = context();
    f.geo.updateRoute = async () => ({
      ok: false,
      error: {
        code: "GEO_BUDGET_EXHAUSTED",
        status: 429,
        message: "budget",
        details: { requiredCredits: 40, availableCredits: -4, shortfallCredits: 44 },
      },
    });
    const result = await applyAiMap({ map: mapFixture("route") }, { type: "preview", change: { type: "optimize" } }, f.ctx);
    expect(result.map.issue).toMatchObject({ requiredCredits: 40, availableCredits: -4, shortfallCredits: 44 });
  });
  test("insertion retry reuses its paid request ID after the failed snapshot is restored", async () => {
    const f = context();
    const original = mapFixture("route");
    original.groups = mapFixture().groups;
    const requests: unknown[] = [];
    f.geo.updateRoute = async (input) => {
      requests.push(structuredClone(input));
      return {
        ok: false,
        error: { code: "GEO_COST_OVERRUN", status: 429, message: "overrun", details: { costs: { settledCredits: 20, unknownCredits: 0 } } },
      };
    };
    const turnId = "3f9833b3-130d-4bf9-8cbd-bb584f9d50b9";
    const result = await applyAiMap(
      { map: original },
      { type: "preview", change: { type: "insert", placeId: original.groups[0]!.places[0]!.id } },
      { ...f.ctx, turnId },
    );
    expect(result.map.issue?.turnId).toBe(turnId);
    const restored = { ...result, map: AiMapSchema.parse(JSON.parse(JSON.stringify(result.map))) };
    await applyAiMap(restored, { type: "retry" }, { ...f.ctx, allowCostOverrunRetry: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });
  test.each(["GEO_BUSY", "GEO_PROVIDER_FAILED", "GEO_BUDGET_EXHAUSTED"])(
    "failed browser recovery keeps confirmation required after %s",
    async (code) => {
      const f = context();
      const turnId = "3f9833b3-130d-4bf9-8cbd-bb584f9d50b9";
      const map = { ...mapFixture("route"), issue: { code: "GEO_COST_OVERRUN", turnId } };
      f.geo.updateRoute = async () => ({ ok: false, error: { code, status: 429, message: "failed" } });
      const retry = { type: "preview", change: { type: "optimize" } } as const;
      const next = await applyAiMap({ map, retry }, { type: "retry" }, { ...f.ctx, allowCostOverrunRetry: true });
      expect(next.map.issue).toMatchObject({ code, turnId, requiresCostConfirmation: true });
      await expect(applyAiMap(next, { type: "retry" }, f.ctx)).rejects.toThrow("MAP_CONFIRM_RETRY_REQUIRED");
      const local = await applyAiMap(next, { type: "discard" }, f.ctx);
      expect(local.map.issue).toEqual(next.map.issue);
    },
  );
  test("browser recovery can resolve an ambiguous stop without releasing the model guard", async () => {
    const f = context();
    const map = { ...mapFixture("route"), issue: { code: "GEO_COST_OVERRUN" } };
    delete map.route;
    const retry = {
      type: "route",
      stops: [
        { id: "a", address: "Ulm" },
        { id: "b", address: "Blaubeuren" },
      ],
      title: "Tour",
    } as const;
    f.geo.calculateRoute = async () => ({
      ok: false,
      error: { code: "GEO_ADDRESS_AMBIGUOUS", status: 409, message: "choose", details: { candidates: [mapAddress()], stopId: "b" } },
    });
    const next = await applyAiMap(
      { map, retry: { ...retry, stops: [...retry.stops] } },
      { type: "retry" },
      { ...f.ctx, allowCostOverrunRetry: true },
    );
    expect(next.map.issue).toMatchObject({ code: "GEO_ADDRESS_AMBIGUOUS", requiresCostConfirmation: true });
    await expect(applyAiMap(next, { type: "choose", index: 0 }, f.ctx)).rejects.toThrow("MAP_CONFIRM_RETRY_REQUIRED");
    f.geo.calculateRoute = async () => mapSuccess({ route: mapFixture("route").route! });
    const chosen = await applyAiMap(next, { type: "choose", index: 0 }, { ...f.ctx, allowCostOverrunRetry: true });
    expect(chosen.map.issue).toBeUndefined();
    expect(chosen.map.plan?.stops[1]?.point).toEqual(mapAddress().point);
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

test("selected stop coordinates survive reservation refusal and allow route recovery", async () => {
  const f = context();
  const calculate = f.geo.calculateRoute;
  f.geo.calculateRoute = async (input, caller) => {
    if (input.plan.stops.some((stop) => !stop.point))
      return {
        ok: false,
        error: {
          code: "GEO_BUDGET_EXHAUSTED",
          status: 429,
          message: "reservation",
          details: {
            scope: "person",
            resetsAt: mapAvailability.person.resetsAt,
            requiredCredits: 325,
            availableCredits: 10,
            shortfallCredits: 315,
          },
        },
      };
    return calculate(input, caller);
  };
  let stored = await createAiMap(
    {
      conversationId: "aBc123",
      command: {
        type: "route",
        title: "Trip",
        stops: [
          { id: "a", address: "Ulm" },
          { id: "b", address: "Blaubeuren" },
          { id: "c", address: "Stuttgart" },
        ],
      },
    },
    f.ctx,
  );
  expect(stored.map.issue?.requiredCredits).toBe(325);
  for (const [index, stopId] of ["a", "b", "c"].entries()) {
    const address = mapAddress(index);
    stored = await applyAiMap(stored, { type: "repair", stopId, address: address.formatted, point: address.point }, f.ctx);
    expect(stored.map.plan?.stops[index]).toEqual({ id: stopId, label: address.formatted, point: address.point });
    if (index < 2) expect(stored.map.issue?.code).toBe("GEO_BUDGET_EXHAUSTED");
  }
  expect(stored.map.route).toBeDefined();
  expect(stored.map.issue).toBeUndefined();
  expect(
    AiMapToolInputSchema.safeParse({ command: { type: "repair", stopId: "a", address: "Ulm", point: mapAddress().point } }).success,
  ).toBe(false);
});
