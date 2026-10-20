import { z } from "zod";

export const GeoPointSchema = z
  .object({
    lat: z.number().min(-90).max(90).describe("Latitude in degrees, -90 to 90."),
    lon: z.number().min(-180).max(180).describe("Longitude in degrees, -180 to 180."),
  })
  .strict();
export const GeoProvenanceSchema = z
  .object({
    provider: z.literal("geoapify"),
    attribution: z.object({ text: z.literal("Geoapify · OpenStreetMap"), links: z.array(z.url()).length(2) }).strict(),
    computedAt: z.iso.datetime(),
  })
  .strict();
const text = z.string().max(300);
export const GeoAddressSchema = z
  .object({
    line1: text,
    postalCode: text,
    city: text,
    stateRegion: text,
    countryCode: z.string().max(2),
    point: GeoPointSchema,
    formatted: z.string().max(600),
    confidence: z.number().min(0).max(1).nullable(),
    provenance: GeoProvenanceSchema,
  })
  .strict();

/** Verified Places categories; names belong to Cloud, provider keys to the adapter. */
export const GEO_CATEGORIES = {
  museum: "entertainment.museum",
  cafe: "catering.cafe",
  restaurant: "catering.restaurant",
  bar: "catering.bar",
  pub: "catering.pub",
  bakery: "commercial.food_and_drink.bakery",
  supermarket: "commercial.supermarket",
  pharmacy: "healthcare.pharmacy",
  hotel: "accommodation.hotel",
  accommodation: "accommodation",
  fuel: "service.vehicle.fuel",
  parking: "parking",
  charging: "service.vehicle.charging_station",
  toilets: "amenity.toilet",
  park: "leisure.park",
  viewpoint: "tourism.attraction.viewpoint",
  attraction: "tourism.attraction",
} as const;
export const GeoCategorySchema = z.enum([
  "museum",
  "cafe",
  "restaurant",
  "bar",
  "pub",
  "bakery",
  "supermarket",
  "pharmacy",
  "hotel",
  "accommodation",
  "fuel",
  "parking",
  "charging",
  "toilets",
  "park",
  "viewpoint",
  "attraction",
]);
export const GeoAreaSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("bbox").describe("Bounding box."),
      west: z.number().describe("Western longitude."),
      south: z.number().describe("Southern latitude."),
      east: z.number().describe("Eastern longitude."),
      north: z.number().describe("Northern latitude."),
    })
    .strict(),
  z
    .object({
      type: z.literal("circle").describe("Circular search area."),
      point: GeoPointSchema.describe("Center of the circle."),
      radiusMeters: z.number().describe("Positive radius in meters."),
    })
    .strict(),
]);
// Bounds are enforced by the service, after authentication/configuration, so all consumers receive GEO_LIMIT_EXCEEDED.
export const GeoAutocompleteInputSchema = z
  .object({
    text: z.string().describe("Partial address, 3–300 characters."),
    limit: z.number().optional().describe("At most 5 suggestions; default 5."),
    countryCode: z.string().optional().describe("Optional ISO alpha-2 country filter."),
    type: z
      .enum(["country", "state", "city", "postcode", "street", "amenity", "locality"])
      .optional()
      .describe("Optional address result type."),
    bias: GeoPointSchema.optional().describe("Optional ranking point."),
    area: GeoAreaSchema.optional().describe("Optional geographic filter."),
  })
  .strict();
export const GeoGeocodeInputSchema = z
  .object({
    text: z.string().optional().describe("Address text, at most 300 characters; use text or fields."),
    fields: z
      .object({
        line1: z.string().optional().describe("Street and house number, at most 200 characters."),
        postalCode: z.string().optional().describe("Postal code, at most 200 characters."),
        city: z.string().optional().describe("City, at most 200 characters."),
        stateRegion: z.string().optional().describe("State or region, at most 200 characters."),
        country: z.string().optional().describe("Country name, at most 200 characters."),
      })
      .strict()
      .optional()
      .describe("Structured address, at most 200 characters per field."),
    countryCode: z.string().optional().describe("Optional ISO alpha-2 country filter."),
  })
  .strict();
export const GeoReverseInputSchema = z.object({ point: GeoPointSchema.describe("Coordinates to reverse geocode.") }).strict();
// 102,400 ASCII bytes matches Geoapify's documented geometry budget, bounding decode memory/work before simplification.
export const GEO_MAX_POLYLINE_CHARS = 102_400;
export const GeoPlaceSearchInputSchema = z
  .object({
    categories: z.array(GeoCategorySchema).describe("1–5 Cloud categories."),
    near: GeoPointSchema.optional().describe("Rank by distance to this point; choose near, area, or along."),
    area: GeoAreaSchema.optional().describe("Optional geographic filter."),
    along: z
      .object({
        polyline6: z.string().describe("Full route as polyline6; at most 102,400 ASCII characters."),
        fromKm: z.number().describe("Start position on the full route in km."),
        toKm: z.number().describe("End position; window at most 200 km."),
        bufferMeters: z.number().optional().describe("100–5,000 m; default 1,000."),
      })
      .strict()
      .optional()
      .describe("Route corridor with a window of at most 200 km."),
    limit: z.number().optional().describe("1–20 results; default 20."),
  })
  .strict();
export const GeoPlaceSchema = z
  .object({
    id: z.string().min(1).max(2048),
    name: text,
    categories: z.array(z.string().max(100)).max(20),
    point: GeoPointSchema,
    address: GeoAddressSchema,
    distanceMeters: z.number().nonnegative().optional(),
    atMeters: z.number().nonnegative().optional(),
    distanceToRouteMeters: z.number().nonnegative().optional(),
    openingHours: z.string().max(1000).optional(),
    website: z.string().max(1000).optional(),
    phone: text.optional(),
    provenance: GeoProvenanceSchema,
  })
  .strict();
export const GeoAutocompleteDataSchema = z
  .object({ suggestions: z.array(GeoAddressSchema).max(5), provenance: GeoProvenanceSchema })
  .strict();
export const GeoGeocodeDataSchema = z.object({ address: GeoAddressSchema, provenance: GeoProvenanceSchema }).strict();
export const GeoReverseDataSchema = GeoGeocodeDataSchema;
export const GeoPlaceSearchDataSchema = z
  .object({
    places: z.array(GeoPlaceSchema).max(20),
    provenance: GeoProvenanceSchema,
    simplificationToleranceMeters: z.number().nonnegative().optional(),
  })
  .strict();
export const GeoAvailabilityInputSchema = z.object({}).strict();
const balance = z.object({ exhausted: z.boolean(), resetsAt: z.iso.datetime() }).strict();
export const GeoAvailabilityDataSchema = z.object({ configured: z.boolean(), person: balance, cloud: balance }).strict();
export const GeoCostsSchema = z.object({ settledCredits: z.number().nonnegative(), unknownCredits: z.number().nonnegative() }).strict();
export const GeoErrorDetailsSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("GEO_NOT_CONFIGURED") }).strict(),
  z.object({ code: z.literal("GEO_FORBIDDEN") }).strict(),
  z.object({ code: z.literal("GEO_UNSUPPORTED_OPTION") }).strict(),
  z.object({ code: z.literal("GEO_ADDRESS_NOT_FOUND") }).strict(),
  z.object({ code: z.literal("GEO_BUDGET_EXHAUSTED"), scope: z.enum(["person", "cloud"]), resetsAt: z.iso.datetime() }).strict(),
  z.object({ code: z.literal("GEO_BUSY"), retryAfterSeconds: z.number().positive(), costs: GeoCostsSchema.optional() }).strict(),
  z.object({ code: z.literal("GEO_LIMIT_EXCEEDED"), limit: z.string(), max: z.number(), actual: z.number() }).strict(),
  z.object({ code: z.literal("GEO_ADDRESS_AMBIGUOUS"), candidates: z.array(GeoAddressSchema).max(5) }).strict(),
  z.object({ code: z.literal("GEO_PROVIDER_FAILED"), costs: GeoCostsSchema, adminHint: z.string().optional() }).strict(),
]);
export type GeoPoint = z.infer<typeof GeoPointSchema>;
export type GeoProvenance = z.infer<typeof GeoProvenanceSchema>;
export type GeoAddress = z.infer<typeof GeoAddressSchema>;
export type GeoPlace = z.infer<typeof GeoPlaceSchema>;
export type GeoAutocompleteInput = z.infer<typeof GeoAutocompleteInputSchema>;
export type GeoGeocodeInput = z.infer<typeof GeoGeocodeInputSchema>;
export type GeoReverseInput = z.infer<typeof GeoReverseInputSchema>;
export type GeoPlaceSearchInput = z.infer<typeof GeoPlaceSearchInputSchema>;
export type GeoErrorCode = z.infer<typeof GeoErrorDetailsSchema>["code"];
export type GeoFunction = "autocomplete" | "geocode" | "reverse" | "places";
export const geoContract = {
  autocomplete: { id: "address.autocomplete", input: GeoAutocompleteInputSchema, data: GeoAutocompleteDataSchema },
  geocode: { id: "address.geocode", input: GeoGeocodeInputSchema, data: GeoGeocodeDataSchema },
  reverse: { id: "address.reverse", input: GeoReverseInputSchema, data: GeoReverseDataSchema },
  searchPlaces: { id: "place.search", input: GeoPlaceSearchInputSchema, data: GeoPlaceSearchDataSchema },
  availability: { id: "geo.availability", input: GeoAvailabilityInputSchema, data: GeoAvailabilityDataSchema },
} as const;
