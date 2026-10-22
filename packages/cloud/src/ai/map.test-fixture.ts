import type { z } from "zod";
import type { CapabilityClientResult } from "../capabilities/types";
import type { GeoAddress, GeoPlace, GeoPoint } from "../contracts/geo";
import type { GeoRoute, GeoRouteUpdateDataSchema } from "../contracts/geo-route";
import type { AiMap } from "./map-contracts";
import type { AiMapGeo } from "./map-service";

export const mapTime = "2026-10-19T14:31:00.000Z";
export const mapProvenance = {
  provider: "geoapify" as const,
  computedAt: mapTime,
  attribution: {
    text: "Geoapify · OpenStreetMap" as const,
    links: ["https://www.geoapify.com/", "https://www.openstreetmap.org/copyright"],
  },
};
export const mapAvailability = {
  configured: true,
  person: { exhausted: false, resetsAt: "2026-10-20T00:00:00.000Z" },
  cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00.000Z" },
};
export const mapAddress = (index = 0): GeoAddress => ({
  line1: `${index + 1} Beispielgasse`,
  postalCode: "89073",
  city: "Ulm",
  stateRegion: "BW",
  countryCode: "DE",
  formatted: `${index + 1} Beispielgasse, Ulm`,
  point: { lat: 48.398 + index * 0.0015, lon: 9.989 + index * 0.002 },
  confidence: 1,
  buildingConfidence: 1,
  provenance: mapProvenance,
});
export const mapPlaces = (count = 6, prefix = "museum"): GeoPlace[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name:
      prefix === "cafe"
        ? ["Café im Kornhaus", "Café am Fluss", "Kleine Backstube", "Café im Hof"][i % 4]!
        : ["Museum am Marktplatz", "Kunsthalle am Münster", "Museum Brot und Kunst", "Donaumuseum", "Stadtmuseum", "Galerie im Hof"][
            i % 6
          ]!,
    categories: [prefix === "cafe" ? "catering.cafe" : "entertainment.museum"],
    point: mapAddress(i).point,
    address: mapAddress(i),
    website: `https://museum-${i}.example/`,
    ...(i === 5 ? {} : { openingHours: "Mo-Su 10:00-17:00" }),
    provenance: mapProvenance,
  }));
export const fixturePolyline = (points: GeoPoint[]) => {
  let lat = 0,
    lon = 0,
    out = "";
  const encode = (diff: number) => {
    let n = diff < 0 ? ~(diff << 1) : diff << 1;
    while (n >= 32) {
      out += String.fromCharCode((32 | (n & 31)) + 63);
      n >>>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const point of points) {
    const nextLat = Math.round(point.lat * 1e6),
      nextLon = Math.round(point.lon * 1e6);
    encode(nextLat - lat);
    encode(nextLon - lon);
    lat = nextLat;
    lon = nextLon;
  }
  return out;
};
export const mapRoute = (): GeoRoute => {
  const stops = ["Ulm", "Bad Urach", "Blautopf", "Stuttgart"].map((name, i) => ({
    id: `stop-${i}`,
    label: name,
    point: { lat: 48.4 + i * 0.08, lon: 10 - i * 0.15 },
  }));
  return {
    distanceAllowanceMeters: 500000,
    stops,
    options: { mode: "car" },
    legs: stops.slice(1).map((stop, i) => ({
      fromStopId: stops[i]!.id,
      toStopId: stop.id,
      options: { mode: "car" },
      distanceMeters: [78000, 34000, 50000][i]!,
      durationSeconds: [4200, 2400, 1980][i]!,
      polyline6: fixturePolyline([stops[i]!.point, stop.point]),
      simplificationToleranceMeters: 0,
      provenance: mapProvenance,
    })),
    distanceMeters: 162000,
    durationSeconds: 8580,
    polyline6: fixturePolyline(stops.map((s) => s.point)),
    simplificationToleranceMeters: 0,
    inputHash: "a".repeat(64),
    provenance: mapProvenance,
  };
};
export const mapFixture = (kind: "places" | "route" = "places"): AiMap => ({
  id: "cb03d253-b2d7-46e1-8a7a-1389c7354d35",
  conversationId: "aBc123",
  revision: 1,
  viewedAt: mapTime,
  timeZone: "Europe/Berlin",
  title: kind === "places" ? "Museen in Ulm" : "Tour Schwäbische Alb",
  kind,
  availability: structuredClone(mapAvailability),
  groups: kind === "places" ? [{ title: "Museen", places: mapPlaces() }] : [],
  web:
    kind === "places"
      ? [
          {
            placeId: "museum-0",
            url: "https://museum-0.example/",
            description: "Stadtgeschichte und moderne Kunst. Eine fiktive Beschreibung für die Darstellung.",
          },
        ]
      : [],
  ...(kind === "route" ? { route: mapRoute() } : {}),
});
export const mapSuccess = <T>(value: T): CapabilityClientResult<T> => ({ ok: true, data: { data: value } });
export const mapGeoFixture = () => {
  const calls: string[] = [];
  const geo: AiMapGeo = {
    availability: async () => {
      calls.push("availability");
      return mapSuccess(mapAvailability);
    },
    geocode: async () => {
      calls.push("geocode");
      return mapSuccess({ address: mapAddress(), provenance: mapProvenance });
    },
    searchPlaces: async (input) => {
      calls.push("places");
      const places = mapPlaces(input.limit === 5 ? 5 : 4, "cafe").map((place, index) => ({
        ...place,
        ...(input.along ? { atMeters: 44000 + index * 4000, distanceToRouteMeters: 300 + index * 10 } : {}),
      }));
      return mapSuccess({ places, provenance: mapProvenance });
    },
    calculateRoute: async () => {
      calls.push("calculate");
      return mapSuccess({ route: mapRoute() });
    },
    updateRoute: async (input) => {
      calls.push("update");
      const route = structuredClone(input.route);
      if (input.changes.type === "insert" && input.changes.stop.point)
        route.stops.splice(2, 0, { id: input.changes.stop.id, label: input.changes.stop.label, point: input.changes.stop.point });
      if (input.changes.type === "optimize") [route.stops[1], route.stops[2]] = [route.stops[2]!, route.stops[1]!];
      if (input.changes.type === "move") {
        const changes = input.changes;
        const i = route.stops.findIndex((s) => s.id === changes.stopId);
        const [stop] = route.stops.splice(i, 1);
        route.stops.splice(input.changes.toIndex, 0, stop!);
      }
      const saving = input.changes.type === "optimize" || input.changes.type === "move";
      const delta = { distanceMeters: saving ? -4000 : 4000, durationSeconds: saving ? -720 : 720 };
      route.distanceMeters += delta.distanceMeters;
      route.durationSeconds += delta.durationSeconds;
      route.polyline6 = fixturePolyline(route.stops.map((s) => s.point));
      route.inputHash = "b".repeat(64);
      const changed: number[] = [];
      route.legs = route.stops.slice(1).map((s, i) => {
        const from = route.stops[i]!;
        const previous = input.route.legs.find((leg) => leg.fromStopId === from.id && leg.toStopId === s.id);
        const optionsChange =
          input.changes.type === "options" &&
          (!input.changes.leg || (input.changes.leg.fromStopId === from.id && input.changes.leg.toStopId === s.id));
        if (!previous || optionsChange) changed.push(i);
        return {
          ...(previous ?? input.route.legs[Math.min(i, input.route.legs.length - 1)]!),
          fromStopId: from.id,
          toStopId: s.id,
          polyline6: fixturePolyline([from.point, s.point]),
          ...(optionsChange && input.changes.type === "options" ? { options: input.changes.options } : {}),
        };
      });
      // Fictional leg numbers still add up to the displayed result and preserve unchanged legs.
      for (const metric of ["distanceMeters", "durationSeconds"] as const) {
        let remaining = route[metric] - route.legs.reduce((sum, leg, i) => sum + (changed.includes(i) ? 0 : leg[metric]), 0);
        changed.forEach((i, index) => {
          const share = Math.floor(remaining / (changed.length - index));
          route.legs[i]![metric] = share;
          remaining -= share;
        });
      }
      const result: z.infer<typeof GeoRouteUpdateDataSchema> = {
        route,
        before: {
          stopIds: input.route.stops.map((s) => s.id),
          distanceMeters: input.route.distanceMeters,
          durationSeconds: input.route.durationSeconds,
        },
        after: { stopIds: route.stops.map((s) => s.id), distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds },
        delta,
      };
      return mapSuccess(result);
    },
  };
  return { geo, calls };
};
