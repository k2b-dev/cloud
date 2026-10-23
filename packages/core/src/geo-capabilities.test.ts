import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CapabilityExecutionContext, capabilityResultSchema, geoContract, geoRouteContract } from "@k2b/cloud/contracts";
import { coreGeo } from "@k2b/cloud/services";
import { GeoError } from "@k2b/cloud/services/geo/errors";
import { GEO_TEST_NOW, geoTestContext } from "@k2b/cloud/services/geo/geo.test-fixture";
import { geoProvenance } from "@k2b/cloud/services/geo/geoapify";
import { aiCapabilities } from "./capabilities";
import { geoCapabilityMessages } from "./geo-capability-messages";
import { geoCapabilityPresentation } from "./geo-capability-presentation";

const context: CapabilityExecutionContext = {
  ...geoTestContext,
  actor: geoTestContext.actor!,
  accessSubject: geoTestContext.accessSubject!,
  locale: "en",
  requestId: "geo-capability-test",
  signal: new AbortController().signal,
  origin: "assistant",
  user: null,
};
afterEach(() => mock.restore());
test("Core registers all geo queries with shared schemas and en/de presentation", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  for (const contract of Object.values({ ...geoContract, ...geoRouteContract })) {
    const entry = manifest.queries.find((query) => query.localId === contract.id)!;
    expect(entry).toBeDefined();
    expect(entry.inputSchema).toEqual(expect.any(Object));
    expect(entry.dataSchema).toEqual(expect.any(Object));
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.description.length).toBeGreaterThan(0);
    expect(geoCapabilityPresentation[contract.id].title).not.toBe(entry.title);
    expect(geoCapabilityPresentation[contract.id].description.length).toBeGreaterThan(0);
    expect(JSON.stringify(entry.inputSchema)).not.toContain('"locale"');
    expect(entry.openWorld).toBe(contract.id !== "geo.availability");
    if (contract.id === "address.geocode") {
      expect(JSON.stringify(entry.inputSchema)).not.toContain('"limit"');
    }
  }
});
test("service accounts retain their access subject and request locale", async () => {
  const provenance = geoProvenance(GEO_TEST_NOW);
  const call = spyOn(coreGeo, "autocomplete").mockResolvedValue({ suggestions: [], provenance });
  const result = await aiCapabilities.queries["address.autocomplete"].run({ text: "Orle" }, context);
  expect(result).toEqual({ ok: true, data: { data: { suggestions: [], provenance } } });
  expect(call).toHaveBeenCalledWith({ text: "Orle" }, context);
  if (result.ok) capabilityResultSchema(geoContract.autocomplete.data).parse(result.data);
});
test("stable errors preserve structured details and localize only their message", async () => {
  spyOn(coreGeo, "autocomplete").mockRejectedValue(
    new GeoError("GEO_BUDGET_EXHAUSTED", { scope: "person", resetsAt: "2026-10-20T22:00:00.000Z" }),
  );
  const en = await aiCapabilities.queries["address.autocomplete"].run({ text: "Orle" }, context);
  const de = await aiCapabilities.queries["address.autocomplete"].run({ text: "Orle" }, { ...context, locale: "de" });
  expect(de).toMatchObject({
    ok: false,
    error: { code: "GEO_BUDGET_EXHAUSTED", details: { scope: "person", resetsAt: "2026-10-20T22:00:00.000Z" } },
  });
  if (!en.ok && !de.ok) expect(en.error.message).not.toBe(de.error.message);
  for (const code of [
    "GEO_NOT_CONFIGURED",
    "GEO_FORBIDDEN",
    "GEO_BUDGET_EXHAUSTED",
    "GEO_BUSY",
    "GEO_LIMIT_EXCEEDED",
    "GEO_UNSUPPORTED_OPTION",
    "GEO_ADDRESS_NOT_FOUND",
    "GEO_ADDRESS_AMBIGUOUS",
    "GEO_PROVIDER_FAILED",
    "GEO_NO_ROUTE",
    "GEO_COST_OVERRUN",
  ] as const) {
    expect(geoCapabilityMessages("de")[code]).not.toBe(geoCapabilityMessages("en")[code]);
  }
});

test("routing queries dispatch through the same service context and structured result contracts", async () => {
  const { savedRouteFixture } = await import("@k2b/cloud/services/geo/route.test-fixture");
  const route = await savedRouteFixture();
  const input = { plan: { stops: route.stops.map((stop) => ({ id: stop.id, point: stop.point })) } };
  const calculate = spyOn(coreGeo, "calculateRoute").mockResolvedValue({ route });
  const result = await aiCapabilities.queries["route.calculate"].run(input, context);
  expect(calculate).toHaveBeenCalledWith(input, context);
  expect(result).toEqual({ ok: true, data: { data: { route } } });
  if (result.ok) capabilityResultSchema(geoRouteContract.calculateRoute.data).parse(result.data);
  const summary = {
    stopIds: route.stops.map((stop) => stop.id),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
  };
  const data = { route, before: summary, after: summary, delta: { distanceMeters: 0, durationSeconds: 0 } };
  const update = spyOn(coreGeo, "updateRoute").mockResolvedValue(data);
  const change = { route, changes: { type: "move" as const, stopId: "B", toIndex: 1 } };
  const updated = await aiCapabilities.queries["route.update"].run(change, context);
  expect(update).toHaveBeenCalledWith(change, context);
  if (updated.ok) capabilityResultSchema(geoRouteContract.updateRoute.data).parse(updated.data);
  calculate.mockRejectedValue(
    new GeoError("GEO_COST_OVERRUN", {
      distanceAllowanceMeters: 500000,
      actualDistanceMeters: 600000,
      costs: { settledCredits: 2, unknownCredits: 0 },
    }),
  );
  expect(await aiCapabilities.queries["route.calculate"].run(input, context)).toMatchObject({
    ok: false,
    error: { code: "GEO_COST_OVERRUN", details: { costs: { settledCredits: 2, unknownCredits: 0 } } },
  });
});
