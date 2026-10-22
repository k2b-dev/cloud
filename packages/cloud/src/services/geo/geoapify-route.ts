import { z } from "zod";
import type { GeoProvenance } from "../../contracts/geo";
import type { GeoRouteLeg, GeoRouteOptions, GeoRouteResolvedStop } from "../../contracts/geo-route";
import { GEO_MAX_ROUTE_RESPONSE_BYTES } from "./cache";
import { GeoError } from "./errors";
import { GeoProviderError } from "./geoapify";
import { compactRouteLine } from "./route-geometry";

const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const resultSchema = z.object({
  results: z
    .array(
      z.object({
        units: z.literal("metric"),
        distance_units: z.literal("meters"),
        distance: z.number().nonnegative(),
        time: z.number().nonnegative(),
        waypoints: z
          .array(z.object({ original_index: z.number().int().min(0).max(25), location: coordinate }))
          .min(2)
          .max(26),
        legs: z
          .array(
            z.object({
              distance: z.number().nonnegative(),
              time: z.number().nonnegative(),
            }),
          )
          .min(1)
          .max(25),
        // Even the shortest JSON coordinate pair takes at least 17 bytes. The response byte cap is authoritative.
        geometry: z
          .array(
            z
              .array(point)
              .min(2)
              .max(Math.floor(GEO_MAX_ROUTE_RESPONSE_BYTES / 17)),
          )
          .max(25),
      }),
    )
    .max(1),
});
const pricedDistanceSchema = z.object({
  results: z
    .array(z.object({ units: z.literal("metric"), distance_units: z.literal("meters"), distance: z.number().nonnegative() }))
    .length(1),
});
export const parseGeoapifyRoute = (
  raw: unknown,
  input: readonly GeoRouteResolvedStop[],
  options: GeoRouteOptions,
  optimize: boolean,
  provenance: GeoProvenance,
) => {
  const priced = pricedDistanceSchema.safeParse(raw);
  const actualDistance = priced.success ? priced.data.results[0]!.distance : undefined;
  const failed = () =>
    new GeoProviderError("GEO_PROVIDER_FAILED", actualDistance === undefined ? "unknown" : "known", false, actualDistance);
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw failed();
  const feature = parsed.data.results[0];
  if (!feature) throw new GeoError("GEO_NO_ROUTE");
  const p = feature,
    indexes = p.waypoints.map((w) => w.original_index);
  if (
    p.legs.length !== input.length - 1 ||
    indexes.length !== input.length ||
    new Set(indexes).size !== input.length ||
    indexes.some((i) => i >= input.length) ||
    indexes[0] !== 0 ||
    indexes.at(-1) !== input.length - 1 ||
    (!optimize && indexes.some((value, i) => value !== i)) ||
    feature.geometry.length !== p.legs.length ||
    Math.abs(p.legs.reduce((sum, leg) => sum + leg.distance, 0) - p.distance) > 1 ||
    Math.abs(p.legs.reduce((sum, leg) => sum + leg.time, 0) - p.time) > 1
  )
    throw failed();
  const stops = indexes.map((i) => input[i]!);
  const legs: GeoRouteLeg[] = p.legs.map((leg, i) => {
    const line = feature.geometry[i]!;
    return {
      fromStopId: stops[i]!.id,
      toStopId: stops[i + 1]!.id,
      options,
      distanceMeters: leg.distance,
      durationSeconds: leg.time,
      ...compactRouteLine(line),
      provenance,
    };
  });
  return { stops, legs, distanceMeters: p.distance };
};
