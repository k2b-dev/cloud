import type { GeoRouteResolvedStop } from "../../contracts/geo-route";
import { geoDistance } from "./polyline";

// Cloud technical budget policy, 2026-10-22: straight-line distance × 2.0.
// Source: places-and-maps.md#reserve-estimated-routing-costs (coordinator decision).
// This is an admission estimate, not a Geoapify guarantee or a measured detour bound.
// All checked routing fixtures are synthetic; no measured fixture supersedes this policy.
export const GEO_ROUTE_DETOUR_FACTOR = 2.0;
// Maximum great-circle distance on the same sphere used by geoDistance. Unknown addresses
// must not become zero-distance legs before geocoding; known coordinates avoid this reserve.
const MAX_STRAIGHT_LINE_METERS = geoDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
type Stop = GeoRouteResolvedStop | undefined;
export const estimateRouteDistance = (stops: readonly Stop[], reorder = false) => {
  const distance = (a: Stop, b: Stop) => (a && b ? geoDistance(a.point, b.point) : MAX_STRAIGHT_LINE_METERS);
  const diameter = reorder ? Math.max(0, ...stops.flatMap((a, i) => stops.slice(i + 1).map((b) => distance(a, b)))) : 0;
  return Math.ceil(
    stops.slice(1).reduce((sum, stop, i) => sum + (reorder ? diameter : distance(stops[i], stop)), 0) * GEO_ROUTE_DETOUR_FACTOR,
  );
};
