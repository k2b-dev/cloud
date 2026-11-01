import { expect, test } from "bun:test";
import { GeoDocumentSchema } from "../contracts/geo-document";
import { mapFixture, mapPlaces } from "./map.test-fixture";
import { AiMapSchema } from "./map-contracts";
import { aiMapNotebookContent } from "./map-notebook";

test("exact export ignores the opening-hours read clock and keeps every group, route field and Unicode", () => {
  const map = mapFixture("route");
  map.title = "Tour 🗺️ — Café 東京";
  map.groups = [
    { title: "Museen", places: mapPlaces(20) },
    { title: "Cafés 東京", places: mapPlaces(20, "cafe") },
  ];
  map.groups[1]!.places[0]!.name = "Café 🥐 <東京> & Fluss";
  map.route!.polyline6 = "??".repeat(15_000);
  for (const leg of map.route!.legs) leg.polyline6 = "??".repeat(30_000);
  AiMapSchema.parse(map);
  const content = aiMapNotebookContent(map);
  expect(content.length).toBeGreaterThan(200_000);
  expect(aiMapNotebookContent({ ...map, viewedAt: "2026-10-22T23:59:59.000Z" })).toBe(content);
  expect(content).not.toContain("savedAt");
  const documents = [...content.matchAll(/:::map\n([^\n]+)\n:::/g)].map((match) => GeoDocumentSchema.parse(JSON.parse(match[1]!)));
  expect(documents).toHaveLength(3);
  expect(documents[0]!.pins).toHaveLength(20);
  expect(documents[1]!.pins).toHaveLength(20);
  expect(documents[1]!.pins[0]!.label).toBe(map.groups[1]!.places[0]!.name);
  expect(documents[2]!.route).toEqual(map.route!);
  expect(documents.every((document) => document.savedAt === undefined)).toBe(true);
});
