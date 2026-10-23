import { afterEach, expect, test } from "bun:test";
import { savedRouteFixture } from "../services/geo/route.test-fixture";
import { geoClient } from "./geo-client";

const original = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = original;
});
test("route client methods preserve the public inputs, caller identity and locale", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const route = await savedRouteFixture();
  const plan = { stops: route.stops.map((stop) => ({ id: stop.id, point: stop.point })), distanceAllowanceMeters: 500000 };
  const result = await geoClient.calculateRoute(
    { plan },
    {
      authorization: "Bearer route-caller",
      locale: "de",
      requestId: "route-client-fixture",
      transport: async (request) => {
        expect(new URL(request.url).pathname).toBe("/api/capabilities/v1/queries/core/route.calculate");
        expect(request.headers.get("authorization")).toBe("Bearer route-caller");
        expect(request.headers.get("x-cloud-locale")).toBe("de");
        expect(await request.json()).toEqual({ input: { plan } });
        return Response.json({ data: { route } });
      },
    },
  );
  expect(result).toMatchObject({ ok: true, data: { data: { route } } });
  const input = {
    route,
    changes: { type: "options" as const, options: { avoid: ["highways" as const] } },
    distanceAllowanceMeters: 1000000,
  };
  const summary = {
    stopIds: route.stops.map((stop) => stop.id),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
  };
  const data = { route, before: summary, after: summary, delta: { distanceMeters: 0, durationSeconds: 0 } };
  const update = await geoClient.updateRoute(input, {
    transport: async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/capabilities/v1/queries/core/route.update");
      expect(await request.json()).toEqual({ input });
      return Response.json({ data });
    },
  });
  expect(update).toMatchObject({ ok: true, data: { data } });
});
test("route clients reject incomplete route responses at the shared boundary", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const result = await geoClient.calculateRoute(
    {
      plan: {
        stops: [
          { id: "A", point: { lat: 48, lon: 10 } },
          { id: "B", point: { lat: 48.1, lon: 10.1 } },
        ],
      },
    },
    { transport: async () => Response.json({ data: { route: { distanceMeters: 1000 } } }) },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE" } });
});
