import type { GeoDocument } from "@k2b/cloud/geo/document";

// Fictional planning content, fixed dates, no provider calls or credentials.
export const mapProvenance = {
  provider: "geoapify" as const,
  attribution: {
    text: "Geoapify · OpenStreetMap" as const,
    links: ["https://www.geoapify.com/", "https://www.openstreetmap.org/copyright"],
  },
  computedAt: "2026-10-19T12:00:00.000Z",
};
export const fictionalMap = (): GeoDocument => ({
  version: 1,
  title: "Karte: Innenstadt",
  pins: [
    {
      id: "n1",
      label: "Münster",
      point: { lat: 48.3984, lon: 9.9916 },
      provenance: mapProvenance,
      link: { type: "note", noteId: "Note01", label: "Münster besteigen" },
    },
    {
      id: "n2",
      label: "Fischerviertel",
      point: { lat: 48.3956, lon: 9.9893 },
      provenance: mapProvenance,
      link: { type: "note", noteId: "Note02", label: "Abendessen" },
    },
    {
      id: "n3",
      label: "Museum Ulm",
      point: { lat: 48.397, lon: 9.9937 },
      provenance: mapProvenance,
      link: { type: "url", url: "https://example.org/museum", label: "Website" },
    },
    {
      id: "n4",
      label: "Glacis-Park Neu-Ulm",
      point: { lat: 48.3889, lon: 10.0014 },
      provenance: mapProvenance,
      link: { type: "heading", noteId: "Note03", heading: "heading-picknick", label: "Picknick Samstag" },
    },
  ],
});
export const fictionalRouteMap = (): GeoDocument => ({
  version: 1,
  title: "Route Tag 2",
  savedAt: "2026-10-19T12:00:00.000Z",
  pins: [],
  route: {
    distanceAllowanceMeters: 500000,
    stops: [
      { id: "a", label: "Ulm Hbf", point: { lat: 48.4, lon: 9.9836 } },
      { id: "b", label: "Blautopf", point: { lat: 48.4159, lon: 9.7853 } },
      { id: "c", label: "Bad Urach", point: { lat: 48.4916, lon: 9.4001 } },
      { id: "d", label: "Stuttgart Hbf", point: { lat: 48.7841, lon: 9.1828 } },
    ],
    options: { mode: "car" },
    legs: [
      {
        fromStopId: "a",
        toStopId: "b",
        options: { mode: "car" },
        distanceMeters: 22000,
        durationSeconds: 1500,
        polyline6: "_gbi{A_fj`Rw`^vhbK",
        simplificationToleranceMeters: 0,
        provenance: mapProvenance,
      },
      {
        fromStopId: "b",
        toStopId: "c",
        options: { mode: "car" },
        distanceMeters: 40000,
        durationSeconds: 2700,
        polyline6: "whaj{Ag|ftQgzrC~ioV",
        simplificationToleranceMeters: 0,
        provenance: mapProvenance,
      },
      {
        fromStopId: "c",
        toStopId: "d",
        options: { mode: "car" },
        distanceMeters: 33000,
        durationSeconds: 1800,
        polyline6: "_dun{Agqv|PghzPflgL",
        simplificationToleranceMeters: 0,
        provenance: mapProvenance,
      },
    ],
    distanceMeters: 95000,
    durationSeconds: 6000,
    polyline6: "_gbi{A_fj`Rw`^vhbKgzrC~ioVghzPflgL",
    simplificationToleranceMeters: 0,
    inputHash: "a".repeat(64),
    provenance: mapProvenance,
  },
});
