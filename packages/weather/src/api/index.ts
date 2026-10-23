import { GeoProvenanceSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, getUserBackedActor, jsonResponse, rateLimit, requiresAuth, respond } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type Context, Hono, type ValidationTargets } from "hono";
import { describeRoute, validator as honoValidator } from "hono-openapi";
import { type ZodType, z } from "zod";
import { CurrentWeatherSchema, WeatherDataSchema, WeatherLocationIdSchema } from "../contracts";
import { weatherMessages } from "../messages";
import { weatherSettingsRouter } from "./settings";
import widgetRoutes from "./widgets";

const geoCaller = (c: Context<AuthContext>) => ({
  cookie: c.req.header("cookie"),
  authorization: c.req.header("authorization"),
  requestId: c.req.header("x-request-id"),
  locale: getLocale(c),
  signal: c.req.raw.signal,
});

const budgetReset = (details: unknown, locale: string) => {
  const value = z.object({ details: z.object({ resetsAt: z.iso.datetime() }) }).safeParse(details);
  return value.success
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(
        new Date(value.data.details.resetsAt),
      ) + " UTC"
    : "—";
};

const coordinateString = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= min && parsed <= max;
    }, `Must be a number between ${min} and ${max}`);

const WeatherQuerySchema = z.object({
  lat: coordinateString(-90, 90).optional(),
  lon: coordinateString(-180, 180).optional(),
});

const ErrorResponseSchema = z.object({
  message: z.string(),
});
const GeoErrorResponseSchema = ErrorResponseSchema.extend({
  code: z.string().optional(),
  details: z
    .object({
      scope: z.enum(["person", "cloud"]).optional(),
      resetsAt: z.iso.datetime().optional(),
      retryAfterSeconds: z.number().optional(),
      costs: z.object({ settledCredits: z.number(), unknownCredits: z.number() }).optional(),
    })
    .passthrough()
    .optional(),
});
const MessageResponseSchema = z.object({
  message: z.string(),
});

const LocationSchema = z.object({
  id: WeatherLocationIdSchema,
  name: z.string(),
  state: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  provenance: GeoProvenanceSchema.nullable().optional(),
});

const CreateLocationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  state: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value ? value : undefined)),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  provenance: GeoProvenanceSchema.optional(),
});

const LocationParamSchema = z.object({
  id: WeatherLocationIdSchema,
});

const GeoResultSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  country: z.string().optional(),
  state: z.string().optional(),
  provenance: GeoProvenanceSchema,
});

const GeoSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  country: z.string().trim().min(2).max(2).optional(),
});

const ForecastByCityQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
});

const localizedV = <Target extends keyof ValidationTargets, T extends ZodType>(
  target: Target,
  schema: T,
  message: (c: Context<AuthContext>) => string,
) =>
  honoValidator(target, schema, (result, c: Context<AuthContext>) => {
    if (!result.success) return respond(c, { ok: false, error: message(c), status: 400 });
  });

const localizedMessage = (select: (t: ReturnType<typeof weatherMessages.resolve>["t"]) => string) => (c: Context<AuthContext>) =>
  select(weatherMessages.resolve([getLocale(c)]).t);

const requireUserBackedActor = (c: Context<AuthContext>): Result<NonNullable<ReturnType<typeof getUserBackedActor>>> => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden(weatherMessages.resolve([getLocale(c)]).t.savedLocationsNeedUser));
  return ok(user);
};

// Locations API (requires auth)
const locationsApi = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .post(
    "/",
    describeRoute({
      tags: ["Weather"],
      summary: "Add a saved location",
      description: "Add a new location to the user's saved locations.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(LocationSchema, "Location created"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
      },
    }),
    localizedV(
      "json",
      CreateLocationSchema,
      localizedMessage((t) => t.invalidLocationInput),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const { name, state, lat, lon, provenance } = c.req.valid("json");

      const result = await weatherService.location.saved.create({ userId: user.data.id, data: { name, state, lat, lon, provenance } });
      return respond(c, result.ok ? result : fail({ ...result.error, message: t.addLocationFailed }), 201);
    },
  )
  .delete(
    "/:id",
    describeRoute({
      tags: ["Weather"],
      summary: "Delete a saved location",
      description: "Remove a location from the user's saved locations.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Location deleted"),
        400: jsonResponse(ErrorResponseSchema, "Invalid location id"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
        404: jsonResponse(ErrorResponseSchema, "Location not found"),
      },
    }),
    localizedV(
      "param",
      LocationParamSchema,
      localizedMessage((t) => t.invalidLocationId),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const { id } = c.req.valid("param");

      return respond(c, async () => {
        const result = await weatherService.location.saved.remove({
          id,
          userId: user.data.id,
        });
        if (!result.ok) {
          return fail({
            ...result.error,
            message: result.error.code === "NOT_FOUND" ? t.capabilityLocationNotFound : t.removeLocationFailed,
          });
        }
        return ok({ message: t.locationDeleted });
      });
    },
  );

/** Weather API routes — public endpoints + auth for locations. */
//
// Mounted at `/api/weather`, so sub-routes become:
//   /api/weather/widget/*  — dashboard widget endpoints (own auth)
//   /api/weather/admin/*   — settings router (admin-gated)
//   /api/weather/...       — CRUD (public weather data + auth-gated locations)

const app = new Hono<AuthContext>()
  .route("/widget", widgetRoutes)
  .route("/admin/settings", weatherSettingsRouter)
  .use(rateLimit())
  // Public: Get weather data
  .get(
    "/",
    describeRoute({
      tags: ["Weather"],
      summary: "Get weather data",
      description:
        "Get current weather, hourly forecast (up to 12 hours), and daily forecast (up to 7 days). Optionally provide lat/lon coordinates, otherwise uses the configured default location.",
      responses: {
        200: jsonResponse(WeatherDataSchema, "Weather data"),
        400: jsonResponse(ErrorResponseSchema, "Invalid coordinates"),
        500: jsonResponse(ErrorResponseSchema, "Failed to fetch weather"),
      },
    }),
    localizedV(
      "query",
      WeatherQuerySchema,
      localizedMessage((t) => t.invalidCoordinates),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const { lat, lon } = c.req.valid("query");
      c.header("Cache-Control", "no-store");

      return respond(c, async () => {
        const data = await weatherService.forecast.get({ lat, lon });
        if (!data) {
          return fail(err.internal(t.fetchWeatherFailed));
        }
        return ok(data);
      });
    },
  )
  // Public: Get current weather only
  .get(
    "/current",
    describeRoute({
      tags: ["Weather"],
      summary: "Get current weather only",
      description: "Get only the current weather conditions. Optionally provide lat/lon coordinates.",
      responses: {
        200: jsonResponse(CurrentWeatherSchema, "Current weather"),
        400: jsonResponse(ErrorResponseSchema, "Invalid coordinates"),
        500: jsonResponse(ErrorResponseSchema, "Failed to fetch weather"),
      },
    }),
    localizedV(
      "query",
      WeatherQuerySchema,
      localizedMessage((t) => t.invalidCoordinates),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const { lat, lon } = c.req.valid("query");

      return respond(c, async () => {
        const data = await weatherService.forecast.current.get({ lat, lon });
        if (!data) {
          return fail(err.internal(t.fetchWeatherFailed));
        }
        return ok(data);
      });
    },
  )
  // Authenticated: city lookups consume the caller’s Core geo budget
  .get(
    "/forecast/by-city",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Weather"],
      summary: "Get forecast by city name",
      ...requiresAuth,
      description: "Uses the first German city search result and returns weather for its coordinates.",
      responses: {
        200: jsonResponse(WeatherDataSchema, "Weather data"),
        400: jsonResponse(ErrorResponseSchema, "Invalid city query"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
        429: jsonResponse(GeoErrorResponseSchema, "Geo budget or provider capacity exhausted"),
        502: jsonResponse(GeoErrorResponseSchema, "Geo provider failed"),
        503: jsonResponse(GeoErrorResponseSchema, "Geo service not configured"),
        404: jsonResponse(ErrorResponseSchema, "City not found"),
        500: jsonResponse(ErrorResponseSchema, "Failed to fetch weather"),
      },
    }),
    localizedV(
      "query",
      ForecastByCityQuerySchema,
      localizedMessage((t) => t.invalidSearchQuery),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const { q } = c.req.valid("query");
      const result = await weatherService.forecast.getByCityName({ query: q, caller: geoCaller(c) });
      if (result.ok) return respond(c, result);
      const message =
        result.error.code === "NOT_FOUND"
          ? t.cityForecastUnavailable
          : result.error.code === "BAD_INPUT"
            ? t.cityQueryRequired
            : result.error.code === "GEO_NOT_CONFIGURED"
              ? t.citySearchNotConfigured
              : result.error.code === "GEO_BUDGET_EXHAUSTED"
                ? t.citySearchBudget({ reset: budgetReset(result.error, getLocale(c)) })
                : t.fetchWeatherFailed;
      return Response.json({ ...result.error, message }, { status: result.error.status });
    },
  )
  // Authenticated: Core address autocomplete
  .get(
    "/geo/search",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Weather"],
      summary: "Search for locations",
      ...requiresAuth,
      description:
        "Suggest up to five German cities using Core address.autocomplete (at least three characters). Requires sign-in and uses the caller’s geo budget.",
      responses: {
        200: jsonResponse(z.array(GeoResultSchema), "Search results"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
        429: jsonResponse(GeoErrorResponseSchema, "Geo budget or provider capacity exhausted"),
        502: jsonResponse(GeoErrorResponseSchema, "Geo provider failed"),
        503: jsonResponse(GeoErrorResponseSchema, "Geo service not configured"),
        500: jsonResponse(ErrorResponseSchema, "Geo service unavailable"),
      },
    }),
    localizedV(
      "query",
      GeoSearchQuerySchema,
      localizedMessage((t) => t.invalidSearchQuery),
    ),
    async (c) => {
      const { t } = weatherMessages.resolve([getLocale(c)]);
      const { q, country } = c.req.valid("query");
      const result = await weatherService.location.city.list({
        caller: geoCaller(c),
        pagination: { page: 1, perPage: 5 },
        filter: { query: q, country },
      });
      if (!result.ok) {
        const message =
          result.error.code === "BAD_INPUT"
            ? t.onlyGermanCitySearch
            : result.error.code === "GEO_NOT_CONFIGURED"
              ? t.citySearchNotConfigured
              : result.error.code === "GEO_BUDGET_EXHAUSTED"
                ? t.citySearchBudget({ reset: budgetReset(result.error, getLocale(c)) })
                : t.locationSearchUnavailable;
        return Response.json({ ...result.error, message }, { status: result.error.status });
      }
      return respond(c, ok(result.data.items));
    },
  )
  // Auth: Locations CRUD
  .route("/locations", locationsApi);

export default app;
export type ApiType = typeof app;
