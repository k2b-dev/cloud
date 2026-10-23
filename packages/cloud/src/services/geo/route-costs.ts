/** Conservative Cloud reference pricing, in integer millicredits; not a provider invoice quote. */
export type GeoRouteCost = { pairs: number; avoids: number; optimize: boolean; distanceMeters: number };
export const geoRouteReferenceCost = ({ pairs, avoids, optimize, distanceMeters }: GeoRouteCost) => {
  const intermediate = pairs - 1;
  const matrix = optimize && intermediate >= 2 ? intermediate * Math.min(intermediate, 10) : 0;
  const cost = (pairs + avoids + matrix) * Math.max(1, Math.ceil(distanceMeters / 500_000)) * 1000;
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Invalid geo routing reference cost");
  return cost;
};
