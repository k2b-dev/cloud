import { expect, test } from "bun:test";
import { savedRouteFixture } from "../services/geo/route.test-fixture";
import { GeoDocumentSchema, serializeGeoDocument } from "./geo-document";

const pin = {
  id: "fictional",
  label: "Fictional museum",
  point: { lat: 48.4, lon: 10 },
  provenance: {
    provider: "geoapify",
    computedAt: "2026-10-19T12:00:00.000Z",
    attribution: { text: "Geoapify · OpenStreetMap", links: ["https://www.geoapify.com/", "https://www.openstreetmap.org/copyright"] },
  },
};
test("saved document preserves full route data and safely serializes authored labels", async () => {
  const document = GeoDocumentSchema.parse({ version: 1, title: "<Map>\n:::\n&", pins: [pin], route: await savedRouteFixture() });
  const markdown = serializeGeoDocument(document);
  expect(markdown).not.toContain("<Map>");
  expect(markdown).not.toContain("&");
  expect(JSON.parse(markdown.split("\n")[1]!)).toEqual(document);
});

test("saved map validates pin bounds, unique IDs and safe links", () => {
  const document = { version: 1, title: "Fictional map", pins: [pin] };
  expect(GeoDocumentSchema.safeParse(document).success).toBe(true);
  expect(GeoDocumentSchema.safeParse({ ...document, pins: [{ ...pin, id: "p".repeat(2048) }] }).success).toBe(true);
  for (const pins of [
    [pin, pin],
    [{ ...pin, label: "x".repeat(301) }],
    [{ ...pin, point: { lat: 91, lon: 10 } }],
    [{ ...pin, link: { type: "url", url: "javascript:alert(1)", label: "Invalid" } }],
    Array.from({ length: 21 }, (_, i) => ({ ...pin, id: String(i) })),
  ]) {
    expect(GeoDocumentSchema.safeParse({ ...document, pins }).success).toBe(false);
  }
});

test("malformed saved polylines fail before SSR or browser map rendering", async () => {
  const route = await savedRouteFixture();
  for (const polyline6 of ["xx", "_", "??_", "\u0001", "_".repeat(100)]) {
    expect(GeoDocumentSchema.safeParse({ version: 1, title: "Fictional route", pins: [], route: { ...route, polyline6 } }).success).toBe(
      false,
    );
  }
});
