import { z } from "zod";
import { GEO_MAX_POLYLINE_CHARS, GeoAddressSchema, GeoGeocodeInputSchema, GeoPointSchema, GeoProvenanceSchema } from "./geo";

export const GEO_ROUTE_MAX_STOPS = 26;
const stopId = z.string().min(1).max(100).describe("Stable stop ID, unique within this route.");
export const GeoRouteOptionsSchema = z
  .object({
    mode: z.enum(["car", "bike", "walk"]).optional().describe("Travel mode; defaults to car."),
    avoid: z
      .array(z.enum(["tolls", "ferries", "highways"]))
      .max(3)
      .optional()
      .describe("Preferences, not prohibitions; tolls/highways require car. Each preference costs extra."),
  })
  .strict();
export const GeoRouteStopSchema = z
  .object({
    id: stopId,
    label: z.string().max(300).optional().describe("Optional display label."),
    point: GeoPointSchema.optional().describe("Known coordinates; choose point or address."),
    address: GeoGeocodeInputSchema.optional().describe("Address to resolve; choose address or point. Ambiguity returns candidates."),
  })
  .strict();
export const GeoRouteResolvedStopSchema = z
  .object({
    id: stopId,
    label: z.string().max(300).optional().describe("Optional display label."),
    point: GeoPointSchema.describe("Resolved stop coordinates."),
    address: GeoAddressSchema.optional().describe("Resolved address, when this stop was geocoded."),
  })
  .strict();
export const GeoRouteLegOptionsSchema = z
  .object({
    fromStopId: stopId,
    toStopId: stopId,
    options: GeoRouteOptionsSchema.describe("Override only the supplied options for this adjacent pair."),
  })
  .strict();
export const GeoRoutePlanSchema = z
  .object({
    stops: z.array(GeoRouteStopSchema).min(2).max(GEO_ROUTE_MAX_STOPS).describe("2–26 stops in travel order, with unique IDs."),
    options: GeoRouteOptionsSchema.optional().describe("Default options for the route."),
    legOptions: z
      .array(GeoRouteLegOptionsSchema)
      .max(25)
      .optional()
      .describe("Options for adjacent stop pairs; on move/optimization each override travels with its departure stop."),
    optimize: z.boolean().optional().describe("Optimize intermediate stops; start and destination stay fixed."),
  })
  .strict();
const geometry = z.string().min(2).max(GEO_MAX_POLYLINE_CHARS);
export const GeoRouteLegSchema = z
  .object({
    fromStopId: stopId,
    toStopId: stopId,
    options: GeoRouteOptionsSchema.describe("Travel options; mode and avoid override only supplied fields."),
    distanceMeters: z.number().nonnegative().describe("Travel distance in meters."),
    durationSeconds: z.number().nonnegative().describe("Estimated travel duration in seconds, without live traffic."),
    polyline6: geometry.describe("Encoded route geometry at precision six."),
    simplificationToleranceMeters: z.number().nonnegative().describe("Conservative geometry simplification tolerance in meters."),
    provenance: GeoProvenanceSchema.describe("Provider provenance and required attribution."),
  })
  .strict();
export const GeoRouteSchema = z
  .object({
    stops: z.array(GeoRouteResolvedStopSchema).min(2).max(GEO_ROUTE_MAX_STOPS).describe("Resolved stops in current travel order."),
    options: GeoRouteOptionsSchema.describe("Travel options; mode and avoid override only supplied fields."),
    legs: z.array(GeoRouteLegSchema).min(1).max(25).describe("Independent stopover legs in travel order."),
    distanceMeters: z.number().nonnegative().describe("Travel distance in meters."),
    durationSeconds: z.number().nonnegative().describe("Estimated travel duration in seconds, without live traffic."),
    polyline6: geometry.describe("Encoded route geometry at precision six."),
    simplificationToleranceMeters: z.number().nonnegative().describe("Conservative geometry simplification tolerance in meters."),
    inputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("SHA-256 fingerprint of the resolved route input; preserve when updating."),
    provenance: GeoProvenanceSchema.describe("Provider provenance and required attribution."),
  })
  .strict()
  .describe("Self-contained stateless route; preserve stops, legs, options and provenance when saving.");
export const GeoRouteChangesSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("insert").describe("Insert one stop."),
      stop: GeoRouteStopSchema.describe("New stop to insert."),
      afterStopId: stopId.optional().describe("Insert after this stop; omit to compare up to three best candidate gaps."),
    })
    .strict(),
  z
    .object({
      type: z.literal("move").describe("Move an existing stop to a new index."),
      stopId,
      toIndex: z.number().int().min(0).max(25).describe("Zero-based destination index in the final stop order."),
    })
    .strict(),
  z.object({ type: z.literal("optimize").describe("Optimize intermediate stop order while fixing start and destination.") }).strict(),
  z
    .object({
      type: z.literal("options").describe("Change route defaults or one leg."),
      options: GeoRouteOptionsSchema.describe("Travel options; mode and avoid override only supplied fields."),
      leg: z
        .object({ fromStopId: stopId, toStopId: stopId })
        .strict()
        .optional()
        .describe("Change just this adjacent pair; omit to change route defaults and clear leg overrides."),
    })
    .strict(),
]);
export const GeoRouteCalculateInputSchema = z.object({ plan: GeoRoutePlanSchema.describe("Route stops and travel preferences.") }).strict();
export const GeoRouteCalculateDataSchema = z.object({ route: GeoRouteSchema }).strict();
export const GeoRouteUpdateInputSchema = z
  .object({
    route: GeoRouteSchema,
    changes: GeoRouteChangesSchema.describe("One stateless route edit to preview."),
  })
  .strict();
export const GeoRouteUpdateDataSchema = z
  .object({
    route: GeoRouteSchema,
    before: z
      .object({
        stopIds: z.array(stopId).min(2).max(26),
        distanceMeters: z.number().nonnegative().describe("Travel distance in meters."),
        durationSeconds: z.number().nonnegative(),
      })
      .strict(),
    after: z
      .object({
        stopIds: z.array(stopId).min(2).max(26),
        distanceMeters: z.number().nonnegative().describe("Travel distance in meters."),
        durationSeconds: z.number().nonnegative(),
      })
      .strict(),
    delta: z.object({ distanceMeters: z.number(), durationSeconds: z.number() }).strict(),
    insertion: z
      .object({ afterStopId: stopId, candidateGaps: z.number().int().min(1).max(3), exhaustive: z.boolean() })
      .strict()
      .optional()
      .describe("Best insertion is a three-gap heuristic when there are more than three gaps."),
  })
  .strict();
export type GeoRouteOptions = z.infer<typeof GeoRouteOptionsSchema>;
export type GeoRouteStop = z.infer<typeof GeoRouteStopSchema>;
export type GeoRouteResolvedStop = z.infer<typeof GeoRouteResolvedStopSchema>;
export type GeoRouteLegOptions = z.infer<typeof GeoRouteLegOptionsSchema>;
export type GeoRoutePlan = z.infer<typeof GeoRoutePlanSchema>;
export type GeoRouteLeg = z.infer<typeof GeoRouteLegSchema>;
export type GeoRoute = z.infer<typeof GeoRouteSchema>;
export type GeoRouteChanges = z.infer<typeof GeoRouteChangesSchema>;
export type GeoRouteCalculateInput = z.infer<typeof GeoRouteCalculateInputSchema>;
export type GeoRouteCalculateData = z.infer<typeof GeoRouteCalculateDataSchema>;
export type GeoRouteUpdateInput = z.infer<typeof GeoRouteUpdateInputSchema>;
export type GeoRouteUpdateData = z.infer<typeof GeoRouteUpdateDataSchema>;
export const geoRouteContract = {
  calculateRoute: { id: "route.calculate", input: GeoRouteCalculateInputSchema, data: GeoRouteCalculateDataSchema },
  updateRoute: { id: "route.update", input: GeoRouteUpdateInputSchema, data: GeoRouteUpdateDataSchema },
} as const;
