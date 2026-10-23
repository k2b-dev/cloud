import type { GeoRouteStop } from "../../contracts/geo-route";
import { geoDistance } from "./polyline";
export const routeStops = (count = 4): GeoRouteStop[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String.fromCharCode(65 + i),
    label: `Fixture stop ${i + 1}`,
    point: { lat: 48 + i * 0.01, lon: 10 + i * 0.01 },
  }));
/** Entirely synthetic, in the documented provider shape; no live data or paid requests. */
export const syntheticRouteResponse = (url: URL, options: { order?: number[]; distances?: number[]; times?: number[] } = {}) => {
  const points = url.searchParams
    .get("waypoints")!
    .split("|")
    .map((value) => {
      const [lat, lon] = value.split(",").map(Number);
      return { lat: lat!, lon: lon! };
    });
  const indexes = options.order ?? points.map((_, i) => i);
  const ordered = indexes.map((index) => points[index]!);
  const legs = ordered.slice(1).map((point, i) => ({
    distance: options.distances?.[i] ?? Math.round(geoDistance(ordered[i]!, point) * 1.2),
    time: options.times?.[i] ?? Math.round(geoDistance(ordered[i]!, point) / 10),
  }));
  return {
    results: [
      {
        mode: url.searchParams.get("mode"),
        units: "metric",
        distance_units: "meters",
        distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
        time: legs.reduce((sum, leg) => sum + leg.time, 0),
        waypoints: indexes.map((index) => ({ original_index: index, location: [points[index]!.lon, points[index]!.lat] })),
        legs,
        geometry: ordered.slice(1).map((point, i) => [ordered[i]!, point]),
      },
    ],
  };
};

export const savedRouteFixture = async () => {
  const { GeoRouteResolvedStopSchema } = await import("../../contracts/geo-route");
  const { GEO_TEST_NOW, GEO_TEST_KEY } = await import("./geo.test-fixture");
  const { GeoapifyAdapter } = await import("./geoapify");
  const { assembleRoute } = await import("./route-plan");
  const stops = routeStops(2).map((stop) => GeoRouteResolvedStopSchema.parse(stop));
  const options = { mode: "car" as const, avoid: [] };
  const result = await new GeoapifyAdapter({
    now: () => GEO_TEST_NOW,
    fetch: async (url) => Response.json(syntheticRouteResponse(url)),
  }).route(stops, options, false, GEO_TEST_KEY, "en");
  return assembleRoute(result.stops, options, result.legs, GEO_TEST_NOW, 500000);
};
