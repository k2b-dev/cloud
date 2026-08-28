import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type AuthContext,
  auth,
  getLocale,
  getUserBackedActor,
  jsonResponse,
  rateLimit,
  requiresAuth,
  respond,
} from "@valentinkolb/cloud/server";
import { weatherService } from "@valentinkolb/cloud/services";
import { type Context, Hono, type ValidationTargets } from "hono";
import { describeRoute, validator as honoValidator } from "hono-openapi";
import { type ZodType, z } from "zod";
import { CurrentWeatherSchema, WeatherDataSchema, WeatherLocationIdSchema } from "../contracts";
import { weatherMessages } from "../messages";
import { weatherSettingsRouter } from "./settings";
import widgetRoutes from "./widgets";

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
const MessageResponseSchema = z.object({
  message: z.string(),
});

const LocationSchema = z.object({
  id: WeatherLocationIdSchema,
  name: z.string(),
  state: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
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
    if (!result.success) return c.json({ message: message(c) }, 400);
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
      const { name, state, lat, lon } = c.req.valid("json");

      const result = await weatherService.location.saved.create({ userId: user.data.id, data: { name, state, lat, lon } });
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
  // Public: Forecast lookup by city name (DE only)
  .get(
    "/forecast/by-city",
    describeRoute({
      tags: ["Weather"],
      summary: "Get forecast by city name",
      description: "Uses the first German city search result and returns weather for its coordinates.",
      responses: {
        200: jsonResponse(WeatherDataSchema, "Weather data"),
        400: jsonResponse(ErrorResponseSchema, "Invalid city query"),
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
      const result = await weatherService.forecast.getByCityName({ query: q });
      if (result.ok) return respond(c, result);
      const message =
        result.error.code === "NOT_FOUND"
          ? t.cityForecastUnavailable
          : result.error.code === "BAD_INPUT"
            ? t.cityQueryRequired
            : t.fetchWeatherFailed;
      return respond(c, fail({ ...result.error, message }));
    },
  )
  // Public: Geo search proxy
  .get(
    "/geo/search",
    describeRoute({
      tags: ["Weather"],
      summary: "Search for locations",
      description: "Search for cities using the configured geo service. Weather app supports country=DE only.",
      responses: {
        200: jsonResponse(z.array(GeoResultSchema), "Search results"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
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
      return respond(c, async () => {
        const result = await weatherService.location.city.list({
          pagination: { page: 1, perPage: 25 },
          filter: { query: q, country },
        });
        if (!result.ok) {
          return fail({
            ...result.error,
            message: result.error.code === "BAD_INPUT" ? t.onlyGermanCitySearch : t.locationSearchUnavailable,
          });
        }
        return ok(result.data.items);
      });
    },
  )
  // Auth: Locations CRUD
  .route("/locations", locationsApi);

export default app;
export type ApiType = typeof app;
