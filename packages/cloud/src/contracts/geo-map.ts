import { z } from "zod";

export const GeoMapStyleInputSchema = z
  .object({
    theme: z.enum(["light", "dark"]).default("light").describe("Map appearance; labels use the request locale."),
  })
  .strict();
export const GeoMapStyleDataSchema = z
  .object({
    styleUrl: z.string().startsWith("/api/geo/style?"),
    attribution: z.array(z.object({ label: z.string(), href: z.url() }).strict()),
  })
  .strict();
export const geoMapContract = { style: { id: "map.style", input: GeoMapStyleInputSchema, data: GeoMapStyleDataSchema } } as const;

// This is a transport memory budget, not an asserted provider maximum. At Free's
// 20 tile requests/s and 10 s deadline, buffered tile bodies occupy at most 200 MiB.
export const GEO_MAX_TILE_BYTES = 1024 * 1024;
export const GEO_MAP_MAX_ZOOM = 14;
