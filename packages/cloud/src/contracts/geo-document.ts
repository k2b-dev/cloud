import { z } from "zod";
import { GeoPointSchema, GeoProvenanceSchema } from "./geo";
import { GeoRouteSchema } from "./geo-route";

// One place.search result fits a saved map. Routes carry their own bounded stops.
export const GEO_DOCUMENT_MAX_PINS = 20;
const shortId = z.string().regex(/^[A-Za-z0-9]{6}$/);
const label = z.string().trim().min(1).max(300);
export const GeoDocumentLinkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.url({ protocol: /^https?$/ }).max(2000), label }).strict(),
  z.object({ type: z.literal("note"), noteId: shortId, label }).strict(),
  z.object({ type: z.literal("heading"), noteId: shortId, heading: z.string().min(1).max(300), label }).strict(),
]);
export const GeoDocumentPinSchema = z.object({
  id: z.string().min(1).max(100),
  label,
  point: GeoPointSchema,
  provenance: GeoProvenanceSchema,
  link: GeoDocumentLinkSchema.optional(),
}).strict();
export const GeoDocumentSchema = z.object({
  version: z.literal(1),
  title: label,
  savedAt: z.iso.datetime().optional(),
  pins: z.array(GeoDocumentPinSchema).max(GEO_DOCUMENT_MAX_PINS),
  route: GeoRouteSchema.optional(),
}).strict().superRefine((document, context) => {
  // Each coordinate consists of up to ten continuation bytes and one terminator.
  // Complete latitude/longitude pairs keep malformed authored geometry out of map renderers.
  if (document.route && !/^(?:[_-~]{0,10}[?-^][_-~]{0,10}[?-^])+$/.test(document.route.polyline6)) {
    context.addIssue({ code: "custom", path: ["route", "polyline6"], message: "Route geometry must contain complete polyline6 coordinate pairs." });
  }
  const ids = new Set<string>();
  document.pins.forEach((pin, index) => {
    if (ids.has(pin.id)) context.addIssue({ code: "custom", path: ["pins", index, "id"], message: "Pin IDs must be unique." });
    ids.add(pin.id);
  });
});
export type GeoDocument = z.infer<typeof GeoDocumentSchema>;
export type GeoDocumentPin = z.infer<typeof GeoDocumentPinSchema>;
export type GeoDocumentLink = z.infer<typeof GeoDocumentLinkSchema>;

/** A portable Notebook block. Escaped JSON cannot close the directive or create HTML. */
export function serializeGeoDocument(input: GeoDocument): string {
  const document = GeoDocumentSchema.parse(input);
  const json = JSON.stringify(document).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `:::map\n${json}\n:::`;
}
