import { mapStyle } from "@k2b/ui";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { GEO_MAP_MAX_ZOOM } from "../contracts/geo-map";
import { type AuthContext, auth, getLocale, v } from "../server";
import { GeoError } from "../services/geo/errors";
import { coreGeoMap } from "../services/geo/map";

const styleQuery = z.object({ theme: z.enum(["light", "dark"]).default("light"), locale: z.enum(["en", "de"]).optional() });
const tileParams = z.object({
  z: z.coerce.number().int().min(0).max(GEO_MAP_MAX_ZOOM),
  x: z.coerce.number().int().nonnegative(),
  y: z.string().regex(/^\d+\.pbf$/),
});
const glyphParams = z.object({ font: z.literal("IBM Plex Sans Medium"), range: z.string().regex(/^\d+-\d+\.pbf$/) });

export const createGeoRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("authenticated"),
  service: typeof coreGeoMap = coreGeoMap,
) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .use("*", auth.requireOAuthScope("read", "admin"))
    .onError((cause, c) => {
      const error = cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED");
      c.header("Cache-Control", "private, no-store");
      if (error.code === "GEO_BUSY") c.header("Retry-After", String(error.details.retryAfterSeconds ?? 1));
      return Response.json(
        { code: error.code, details: error.details },
        {
          status: error.status,
          headers: {
            "Cache-Control": "private, no-store",
            ...(error.code === "GEO_BUSY" ? { "Retry-After": String(error.details.retryAfterSeconds ?? 1) } : {}),
          },
        },
      );
    })
    .get(
      "/style",
      describeRoute({ tags: ["Places and maps"], summary: "Get the Cloud map style with same-origin tiles and glyphs" }),
      v("query", styleQuery),
      async (c) => {
        const query = c.req.valid("query");
        const locale = query.locale ?? getLocale(c);
        await service.style({ theme: query.theme }, { actor: c.get("actor"), accessSubject: c.get("accessSubject"), locale });
        c.header("Cache-Control", "private, no-store");
        return c.json(
          mapStyle({
            theme: query.theme,
            locale,
            tiles: "/api/geo/tiles/{z}/{x}/{y}.pbf",
            glyphs: "/api/geo/glyphs/{fontstack}/{range}.pbf",
            maxzoom: GEO_MAP_MAX_ZOOM,
          }),
        );
      },
    )
    .get(
      "/tiles/:z/:x/:y",
      describeRoute({ tags: ["Places and maps"], summary: "Load one budgeted Geoapify EU vector tile" }),
      v("param", tileParams),
      async (c) => {
        const params = c.req.valid("param");
        const bytes = await service.tile(
          { z: params.z, x: params.x, y: Number(params.y.slice(0, -4)) },
          {
            actor: c.get("actor"),
            accessSubject: c.get("accessSubject"),
            locale: getLocale(c),
            signal: c.req.raw.signal,
          },
        );
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/vnd.mapbox-vector-tile",
            "Cache-Control": "private, max-age=604800",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    )
    .get(
      "/glyphs/:font/:range",
      describeRoute({ tags: ["Places and maps"], summary: "Load locally bundled IBM Plex map labels" }),
      v("param", glyphParams),
      async (c) => {
        const { font, range } = c.req.valid("param");
        const [start, end] = range.slice(0, -4).split("-").map(Number);
        if (start === undefined || end === undefined || start < 0 || end > 65535 || start % 256 !== 0 || end !== start + 255)
          return c.notFound();
        const file = Bun.file(new URL(`./map-glyphs/${encodeURIComponent(font)}/${range}`, import.meta.resolve("@k2b/ui/package.json")));
        if (!(await file.exists())) return c.notFound();
        return new Response(file, {
          headers: {
            "Content-Type": "application/x-protobuf",
            "Cache-Control": "private, max-age=604800",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    );

export default createGeoRoutes();
