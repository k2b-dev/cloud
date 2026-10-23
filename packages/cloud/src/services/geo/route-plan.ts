import { createHash } from "node:crypto";
import type { GeoPoint } from "../../contracts/geo";
import {
  type GeoRoute,
  type GeoRouteLeg,
  type GeoRouteOptions,
  type GeoRoutePlan,
  type GeoRouteResolvedStop,
  GeoRouteSchema,
  type GeoRouteStop,
} from "../../contracts/geo-route";
import { GEO_MAX_JSON_BYTES, normalizeGeoInput } from "./cache";
import { GeoError, limitExceeded } from "./errors";
import { geoProvenance } from "./geoapify";
import { decodePolyline6, geoDistance } from "./polyline";
import { compactRouteLine, joinRouteLines } from "./route-geometry";

export const routeOptions = (value: GeoRouteOptions = {}, base: GeoRouteOptions = {}): GeoRouteOptions => {
  const mode = value.mode ?? base.mode ?? "car";
  const avoid = [...new Set(value.avoid ?? base.avoid ?? [])].sort();
  if (mode !== "car" && avoid.some((option) => option !== "ferries")) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  return { mode, avoid };
};
export const sameRouteOptions = (a: GeoRouteOptions, b: GeoRouteOptions) =>
  JSON.stringify(routeOptions(a)) === JSON.stringify(routeOptions(b));
export const validateRouteStops = (stops: readonly GeoRouteStop[]) => {
  if (stops.length < 2 || stops.length > 26) limitExceeded("stops", stops.length < 2 ? 2 : 26, stops.length);
  if (new Set(stops.map((stop) => stop.id)).size !== stops.length) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  for (const stop of stops) {
    if (!!stop.point === !!stop.address) throw new GeoError("GEO_UNSUPPORTED_OPTION");
    if (!stop.address) continue;
    const address = stop.address;
    if (address.text !== undefined && (!address.text.trim() || address.text.length > 300))
      limitExceeded("address.text", 300, address.text.length);
    for (const [key, field] of Object.entries(address.fields ?? {}))
      if (field !== undefined && field.length > 200) limitExceeded(`address.fields.${key}`, 200, field.length);
    if (
      !!address.text?.trim() === !!Object.values(address.fields ?? {}).some((field) => field?.trim()) ||
      (address.countryCode !== undefined && !/^[a-z]{2}$/i.test(address.countryCode))
    )
      throw new GeoError("GEO_UNSUPPORTED_OPTION");
  }
};
export const validateRoutePlan = (plan: GeoRoutePlan) => {
  validateRouteStops(plan.stops);
  const defaults = routeOptions(plan.options);
  const byDeparture = new Map<string, GeoRouteOptions>();
  for (const entry of plan.legOptions ?? []) {
    const index = plan.stops.findIndex((stop) => stop.id === entry.fromStopId);
    if (index < 0 || plan.stops[index + 1]?.id !== entry.toStopId || byDeparture.has(entry.fromStopId))
      throw new GeoError("GEO_UNSUPPORTED_OPTION");
    byDeparture.set(entry.fromStopId, routeOptions(entry.options, defaults));
  }
  return { defaults, byDeparture };
};
export const walkDistance = (stops: readonly GeoRouteResolvedStop[], options: GeoRouteOptions) => {
  if (options.mode !== "walk") return;
  for (let i = 1; i < stops.length; i++) {
    const distance = geoDistance(stops[i - 1]!.point, stops[i]!.point);
    if (distance > 100_000) limitExceeded("walk.legMeters", 100_000, distance);
  }
};
const routeHash = (stops: readonly GeoRouteResolvedStop[], options: GeoRouteOptions, legs: readonly GeoRouteLeg[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        normalizeGeoInput(
          {
            stops,
            options,
            legOptions: legs.map((leg) => ({
              fromStopId: leg.fromStopId,
              toStopId: leg.toStopId,
              options: leg.options,
            })),
          },
          "route",
        ),
      ),
    )
    .digest("hex");
export const assembleRoute = (
  stops: GeoRouteResolvedStop[],
  defaults: GeoRouteOptions,
  originalLegs: GeoRouteLeg[],
  now: Date,
  distanceAllowanceMeters: number,
): GeoRoute => {
  let legs = originalLegs;
  const build = (): GeoRoute => ({
    stops,
    options: defaults,
    legs,
    distanceAllowanceMeters,
    distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    polyline6: joinRouteLines(legs.map((leg) => leg.polyline6)),
    simplificationToleranceMeters: Math.max(...legs.map((leg) => leg.simplificationToleranceMeters)),
    inputHash: routeHash(stops, defaults, legs),
    provenance: geoProvenance(now),
  });
  let route = build();
  // Leave space for the capability envelope and update's before/after/delta metadata.
  // Always simplify from the original geometry, so repeated iterations do not compound the stated tolerance.
  const lines = originalLegs.map((leg) => decodePolyline6(leg.polyline6));
  // Each polyline point uses at most 12 ASCII bytes, and appears in its leg and the whole route.
  // Reserve the actual metadata size before dividing the available geometry budget across legs.
  const metadataBytes = Buffer.byteLength(
    JSON.stringify({ data: { route: { ...route, polyline6: "", legs: legs.map((leg) => ({ ...leg, polyline6: "" })) } } }),
  );
  const pointLimit = Math.max(
    2,
    Math.min(2000, Math.floor((GEO_MAX_JSON_BYTES - 8192 - metadataBytes) / (24 * legs.length)), Math.floor(102400 / (12 * legs.length))),
  );
  let tolerance = 1;
  while (Buffer.byteLength(JSON.stringify({ data: { route } })) > GEO_MAX_JSON_BYTES - 8192 || route.polyline6.length > 102400) {
    legs = originalLegs.map((leg, i) => {
      const compacted = compactRouteLine(lines[i]!, tolerance, pointLimit);
      return {
        ...leg,
        ...compacted,
        simplificationToleranceMeters: leg.simplificationToleranceMeters + compacted.simplificationToleranceMeters,
      };
    });
    route = build();
    tolerance *= 2;
    if (tolerance > 40_100_000) throw new GeoError("GEO_PROVIDER_FAILED");
  }
  return GeoRouteSchema.parse(route);
};
export const validateSavedRoute = (route: GeoRoute) => {
  if (Buffer.byteLength(JSON.stringify(route)) > GEO_MAX_JSON_BYTES)
    limitExceeded("route.bytes", GEO_MAX_JSON_BYTES, Buffer.byteLength(JSON.stringify(route)));
  if (new Set(route.stops.map((stop) => stop.id)).size !== route.stops.length || route.legs.length !== route.stops.length - 1)
    throw new GeoError("GEO_UNSUPPORTED_OPTION");
  const validProvenance = (value: GeoRoute["provenance"]) =>
    value.attribution.links[0] === "https://geoapify.com" && value.attribution.links[1] === "https://www.openstreetmap.org/copyright";
  if (!validProvenance(route.provenance) || route.stops.some((stop) => stop.address && !validProvenance(stop.address.provenance)))
    throw new GeoError("GEO_UNSUPPORTED_OPTION");
  routeOptions(route.options);
  for (const [i, leg] of route.legs.entries()) {
    if (leg.fromStopId !== route.stops[i]!.id || leg.toStopId !== route.stops[i + 1]!.id) throw new GeoError("GEO_UNSUPPORTED_OPTION");
    if (!validProvenance(leg.provenance)) throw new GeoError("GEO_UNSUPPORTED_OPTION");
    routeOptions(leg.options);
    decodePolyline6(leg.polyline6);
  }
  decodePolyline6(route.polyline6);
  if (
    Math.abs(route.distanceMeters - route.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0)) > 1e-6 ||
    Math.abs(route.durationSeconds - route.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0)) > 1e-6 ||
    route.polyline6 !== joinRouteLines(route.legs.map((leg) => leg.polyline6)) ||
    route.inputHash !== routeHash(route.stops, route.options, route.legs)
  )
    throw new GeoError("GEO_UNSUPPORTED_OPTION");
};
export const routeSummary = (route: GeoRoute) => ({
  stopIds: route.stops.map((stop) => stop.id),
  distanceMeters: route.distanceMeters,
  durationSeconds: route.durationSeconds,
});
export const insertionGaps = (route: GeoRoute, point: GeoPoint) =>
  route.legs
    .map((_, index) => ({
      index,
      detour:
        geoDistance(route.stops[index]!.point, point) +
        geoDistance(point, route.stops[index + 1]!.point) -
        geoDistance(route.stops[index]!.point, route.stops[index + 1]!.point),
    }))
    .sort((a, b) => a.detour - b.detour || a.index - b.index)
    .slice(0, 3)
    .map((gap) => gap.index);
