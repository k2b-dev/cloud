import { z } from "zod";
import {
  GeoAddressSchema,
  GeoAvailabilityDataSchema,
  GeoCategorySchema,
  GeoCostsSchema,
  GeoPlaceSchema,
  GeoPointSchema,
} from "../contracts/geo";
import {
  GeoRouteChangesSchema,
  GeoRouteOptionsSchema,
  GeoRoutePlanSchema,
  GeoRouteSchema,
  GeoRouteUpdateDataSchema,
} from "../contracts/geo-route";

const label = z.string().trim().min(1).max(160);
const web = z.object({ placeId: z.string().max(2048), description: z.string().max(600), url: z.url().max(2000) }).strict();
// A map may accumulate two full Places result pages. Subsequent searches replace the secondary group.
export const AiMapSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.string(),
    revision: z.number().int().positive(),
    title: label,
    selectionId: z.string().optional(),
    timeZone: z.string().optional(),
    kind: z.enum(["places", "route"]),
    pending: z.boolean().optional(),
    pendingTurnId: z.uuid().optional(),
    retryUsesMarks: z.boolean().optional(),
    originCallId: z.string().optional(),
    anchorSeq: z.number().int().positive().optional(),
    viewedAt: z.iso.datetime().optional(),
    lastSearch: z
      .object({
        categories: z.array(GeoCategorySchema),
        near: z.string().optional(),
        placeId: z.string().optional(),
        radiusMeters: z.number().optional(),
        title: label,
        along: z.object({ fromKm: z.number(), toKm: z.number(), bufferMeters: z.number().optional() }).optional(),
      })
      .optional(),
    searchAddress: z.object({ text: z.string(), address: GeoAddressSchema }).strict().optional(),
    availability: GeoAvailabilityDataSchema,
    groups: z.array(z.object({ title: label, places: z.array(GeoPlaceSchema).max(20) }).strict()).max(2),
    web: z.array(web).max(40),
    route: GeoRouteSchema.optional(),
    plan: GeoRoutePlanSchema.optional(),
    preview: z.object({ result: GeoRouteUpdateDataSchema, changes: GeoRouteChangesSchema, title: label }).strict().optional(),
    undo: z.object({ route: GeoRouteSchema, title: label }).strict().optional(),
    receipt: z.object({ title: label, at: z.iso.datetime() }).strict().optional(),
    candidates: z.array(GeoAddressSchema).max(5).optional(),
    ambiguousStopId: z.string().optional(),
    picker: z.array(GeoPlaceSchema).max(5).optional(),
    issue: z
      .object({
        code: z.string(),
        scope: z.enum(["person", "cloud"]).optional(),
        resetsAt: z.string().optional(),
        retryAfterSeconds: z.number().optional(),
        costs: GeoCostsSchema.optional(),
        distanceAllowanceMeters: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AiMap = z.infer<typeof AiMapSchema>;

const search = z
  .object({
    categories: z.array(GeoCategorySchema).min(1).max(5),
    near: z.string().min(1).max(300).optional(),
    placeId: z.string().max(2048).optional(),
    radiusMeters: z.number().min(1).max(50000).optional(),
    along: z
      .object({ fromKm: z.number().nonnegative(), toKm: z.number().positive(), bufferMeters: z.number().min(100).max(5000).optional() })
      .strict()
      .optional(),
    title: label,
  })
  .strict();
// Model-facing inputs cannot inject points, polylines, or a provider result. These are resolved on the server.
const stop = z
  .object({
    id: z.string().min(1).max(40),
    address: z.string().min(1).max(300).optional(),
    placeId: z.string().max(2048).optional(),
    label: label.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.address) !== Boolean(value.placeId), "Supply exactly one address or verified place ID");
export const AiMapCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("places"), search, web: z.array(web).max(20).optional() }).strict(),
  z
    .object({
      type: z.literal("route"),
      stops: z
        .array(stop)
        .min(2)
        .max(26)
        .refine((stops) => new Set(stops.map((s) => s.id)).size === stops.length, "Stop IDs must be unique"),
      options: GeoRouteOptionsSchema.optional(),
      distanceAllowanceMeters: GeoRoutePlanSchema.shape.distanceAllowanceMeters,
      title: label,
    })
    .strict(),
  z.object({ type: z.literal("search"), search, insert: z.boolean().optional(), web: z.array(web).max(20).optional() }).strict(),
  z.object({ type: z.literal("describe"), web: z.array(web).max(40) }).strict(),
  z
    .object({
      type: z.literal("preview"),
      change: z.discriminatedUnion("type", [
        z.object({ type: z.literal("insert"), placeId: z.string().max(2048), afterStopId: z.string().optional() }).strict(),
        z.object({ type: z.literal("move"), stopId: z.string(), toIndex: z.number().int().min(0).max(25) }).strict(),
        z.object({ type: z.literal("optimize") }).strict(),
        z
          .object({
            type: z.literal("options"),
            options: GeoRouteOptionsSchema,
            leg: z.object({ fromStopId: z.string(), toStopId: z.string() }).strict().optional(),
          })
          .strict(),
      ]),
      distanceAllowanceMeters: GeoRoutePlanSchema.shape.distanceAllowanceMeters,
    })
    .strict(),
  z.object({ type: z.literal("choose"), index: z.number().int().min(0).max(4) }).strict(),
  z.object({ type: z.literal("accept") }).strict(),
  z.object({ type: z.literal("discard") }).strict(),
  z.object({ type: z.literal("undo") }).strict(),
  z.object({ type: z.literal("retry"), distanceAllowanceMeters: GeoRoutePlanSchema.shape.distanceAllowanceMeters }).strict(),
]);
export const AiMapBrowserCommandSchema = z.union([
  AiMapCommandSchema,
  z.object({ type: z.literal("location"), destinationId: z.string(), point: GeoPointSchema }).strict(),
  z.object({ type: z.literal("repair"), stopId: z.string(), address: z.string().trim().min(1).max(300) }).strict(),
]);
export type AiMapCommand = z.infer<typeof AiMapBrowserCommandSchema>;
export const AiMapToolInputSchema = z
  .object({ mapId: z.uuid().optional(), revision: z.number().int().positive().optional(), command: AiMapCommandSchema })
  .strict();
export const AiMapReferenceSchema = AiMapSchema.pick({
  id: true,
  conversationId: true,
  revision: true,
  title: true,
  kind: true,
  pending: true,
  anchorSeq: true,
}).extend({ reference: z.literal(true) });
export const AiMapToolResultSchema = z
  .object({ map: z.union([AiMapSchema, AiMapReferenceSchema]), anchor: z.boolean(), summary: z.unknown().optional() })
  .strict();
/** Geometry belongs to the durable map, never to the model context or streaming result budget. */
export const aiMapToolResult = (map: AiMap, anchor: boolean): z.infer<typeof AiMapToolResultSchema> => ({
  anchor,
  map: {
    reference: true,
    id: map.id,
    conversationId: map.conversationId,
    revision: map.revision,
    title: map.title,
    kind: map.kind,
    pending: map.pending,
    anchorSeq: map.anchorSeq,
  },
  summary: {
    mapId: map.id,
    revision: map.revision,
    places: map.groups.map((g) => ({
      title: g.title.slice(0, 64),
      places: g.places.map((p, i) => ({
        id: map.groups.indexOf(g) === 0 ? String(i + 1) : String.fromCharCode(65 + i),
        name: p.name.slice(0, 48),
      })),
    })),
    candidates: map.candidates?.map((p, index) => ({ index, address: p.formatted.slice(0, 96) })),
    picker: map.picker?.map((p, i) => ({ id: `pick-${i + 1}`, name: p.name.slice(0, 48), atMeters: p.atMeters })),
    stops: map.route?.stops.map((s) => ({ id: s.id, label: s.label?.slice(0, 48) })),
    distanceMeters: map.route?.distanceMeters,
    durationSeconds: map.route?.durationSeconds,
    preview: map.preview ? { title: map.preview.title, delta: map.preview.result.delta } : undefined,
    issue: map.issue,
  },
});
export type AiMapToolResult = z.infer<typeof AiMapToolResultSchema>;
export const AiMapActionSchema = z.object({ revision: z.number().int().positive(), command: AiMapBrowserCommandSchema }).strict();
