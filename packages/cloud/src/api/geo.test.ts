import { expect, mock, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import { GeoError } from "../services/geo/errors";
import { geoTestContext } from "../services/geo/geo.test-fixture";
import type { coreGeoMap } from "../services/geo/map";
import { createGeoRoutes } from "./geo";

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (geoTestContext.actor) c.set("actor", geoTestContext.actor);
  if (geoTestContext.accessSubject) c.set("accessSubject", geoTestContext.accessSubject);
  await next();
};
const service: typeof coreGeoMap = {
  style: async () => ({ styleUrl: "/api/geo/style?theme=light&locale=de", attribution: [] }),
  tile: async () => new Uint8Array([26, 0]),
};

test("all map assets require authentication and OAuth read scope", async () => {
  for (const path of ["/style", "/tiles/0/0/0.pbf", "/glyphs/IBM%20Plex%20Sans%20Medium/0-255.pbf"]) {
    expect((await createGeoRoutes().request(path)).status).toBe(401);
    const denied: MiddlewareHandler<AuthContext> = async (c, next) => {
      c.set("oauthScopes", ["openid"]);
      await next();
    };
    expect((await createGeoRoutes(denied, service).request(path)).status).toBe(403);
  }
});

test("light and dark styles contain only same-origin asset URLs", async () => {
  for (const theme of ["light", "dark"]) {
    const response = await createGeoRoutes(authenticate, service).request(`/style?theme=${theme}&locale=de`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.name).toBe(`Cloud ${theme}`);
    expect(body.glyphs).toBe("/api/geo/glyphs/{fontstack}/{range}.pbf");
    expect(body.sources.openmaptiles.tiles).toEqual(["/api/geo/tiles/{z}/{x}/{y}.pbf"]);
    expect(JSON.stringify(body)).not.toContain("geoapify.com");
    expect(JSON.stringify(body)).toContain("name:de");
  }
});

test("tiles cache privately and report structured budget recovery without caching the error", async () => {
  const response = await createGeoRoutes(authenticate, service).request("/tiles/0/0/0.pbf");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, max-age=604800");
  expect(response.headers.get("content-type")).toBe("application/vnd.mapbox-vector-tile");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([26, 0]));
  const failing = {
    ...service,
    tile: async () => {
      throw new GeoError("GEO_BUDGET_EXHAUSTED", { scope: "person", resetsAt: "2026-10-21T00:00:00Z" });
    },
  };
  const failure = await createGeoRoutes(authenticate, failing).request("/tiles/0/0/0.pbf");
  expect(failure.status).toBe(429);
  expect(failure.headers.get("cache-control")).toBe("private, no-store");
  expect(await failure.json()).toEqual({ code: "GEO_BUDGET_EXHAUSTED", details: { scope: "person", resetsAt: "2026-10-21T00:00:00Z" } });
});

test("glyphs are bundled and paths cannot select arbitrary files", async () => {
  const app = createGeoRoutes(authenticate, service);
  const glyph = await app.request("/glyphs/IBM%20Plex%20Sans%20Medium/0-255.pbf");
  expect(glyph.status).toBe(200);
  expect((await glyph.arrayBuffer()).byteLength).toBeGreaterThan(0);
  for (const path of [
    "/glyphs/other/0-255.pbf",
    "/glyphs/IBM%20Plex%20Sans%20Medium/1-256.pbf",
    "/glyphs/IBM%20Plex%20Sans%20Medium/65536-65791.pbf",
  ])
    expect((await app.request(path)).status).toBeGreaterThanOrEqual(400);
});

test("invalid tile paths do not reach the paid service", async () => {
  const tile = mock(service.tile);
  const app = createGeoRoutes(authenticate, { ...service, tile });
  for (const path of ["/tiles/15/0/0.pbf", "/tiles/1/-1/0.pbf", "/tiles/1/0/not-a-tile"])
    expect((await app.request(path)).status).toBe(400);
  expect(tile).not.toHaveBeenCalled();
});
