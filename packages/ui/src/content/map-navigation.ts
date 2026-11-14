import type { MapViewPoint } from "./map-view-types";

export type GeoNavigationPlatform = "android" | "ios" | "desktop";

/** Phones open their own maps app; everything else gets OpenStreetMap. */
export const geoNavigationPlatform = (userAgent: string): GeoNavigationPlatform =>
  /android/i.test(userAgent) ? "android" : /iphone|ipad|ipod/i.test(userAgent) ? "ios" : "desktop";

/**
 * A link into a navigation app. There is no live navigation; the link leaves the page only on click and carries
 * just the destination and an optional name. Without a point it navigates to the address text.
 */
export const geoNavigationHref = (
  target: { point?: MapViewPoint | null; text: string; name?: string },
  platform: GeoNavigationPlatform,
): string => {
  const point = target.point ? `${target.point.lat},${target.point.lon}` : null;
  const text = encodeURIComponent(target.text);
  if (platform === "android")
    return point ? `geo:0,0?q=${point}${target.name ? `(${encodeURIComponent(target.name)})` : ""}` : `geo:0,0?q=${text}`;
  if (platform === "ios") return `https://maps.apple.com/?daddr=${point ? encodeURIComponent(point) : text}`;
  return point
    ? `https://www.openstreetmap.org/directions?route=%3B${encodeURIComponent(point)}`
    : `https://www.openstreetmap.org/search?query=${text}`;
};
