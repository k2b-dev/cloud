import { err, fail, ok, type Paginated, type Result } from "@k2b/stdlib";
import {
  type CapabilityExecutionContext,
  type CapabilityInvocationResult,
  type CapabilityResult,
  CapabilitySemanticLinkSchema,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { type AuditActor, audit, weatherService } from "@valentinkolb/cloud/services";
import { z } from "zod";
import { weatherCapabilityPresentation } from "./capability-presentation";
import { CurrentWeatherSchema, WeatherDataSchema, WeatherIconSchema, WeatherLocationIdSchema } from "./contracts";
import { resolveWeatherMessages, type WeatherMessages } from "./messages";

const MAX_CURSOR_OFFSET = 10_000;
const WEATHER_LOCATIONS_APPROVAL_SCOPE = "locations";

const unavailable = <T>(t: WeatherMessages): CapabilityInvocationResult<T> =>
  fail({
    code: "WEATHER_UNAVAILABLE",
    message: t.capabilityWeatherUnavailable,
    status: 500,
  });

const citySearchUnavailable = <T>(t: WeatherMessages): CapabilityInvocationResult<T> =>
  fail({
    code: "WEATHER_CITY_SEARCH_UNAVAILABLE",
    message: t.capabilityCitySearchUnavailable,
    status: 500,
  });

const LocationSchema = z
  .object({
    id: WeatherLocationIdSchema,
    name: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(120).nullable(),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
    links: z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional(),
  })
  .strict();
const LocationListItemSchema = LocationSchema.extend({
  ref: z.object({ type: z.literal("weather.location"), id: WeatherLocationIdSchema }).strict(),
}).strict();

const LocationListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of saved locations to return."),
    cursor: z.string().min(1).max(2048).optional().describe("Opaque cursor returned by a previous location.list call."),
  })
  .strict();

const LocationReadInputSchema = z
  .object({
    id: WeatherLocationIdSchema.describe("Saved-location ID returned by saved-location search/list or a weather.location ref."),
  })
  .strict();

const LocationTargetInputSchema = z
  .object({
    locationId: WeatherLocationIdSchema.describe("Saved-location ID returned by saved-location search/list or a weather.location ref."),
  })
  .strict();

const ForecastSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("saved").describe("Use a saved location owned by the current user."),
      locationId: WeatherLocationIdSchema.describe("Saved-location ID returned by saved-location search/list or a weather.location ref."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("coordinates").describe("Use explicit latitude and longitude."),
      lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees from -90 to 90."),
      lon: z.number().min(-180).max(180).describe("Longitude in decimal degrees from -180 to 180."),
    })
    .strict(),
]);

const ForecastInputSchema = z
  .object({
    source: ForecastSourceSchema.describe("Saved location or explicit coordinates used for the forecast."),
  })
  .strict();

const CitySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(120).describe("German city name to geocode; this searches city candidates, not saved locations."),
    limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of city candidates to return."),
  })
  .strict();

const CitySearchDataSchema = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(160),
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-180).max(180),
        country: z.string().trim().min(1).max(16).optional(),
        state: z.string().trim().min(1).max(160).optional(),
      })
      .strict(),
  )
  .max(25);

const LocationCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).describe("Display name; normally copy name from the chosen Search German cities result."),
    state: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Optional state or region; normally copy state from the chosen city result when present."),
    lat: z.number().min(-90).max(90).describe("Latitude copied from the chosen city result, or another trusted coordinate source."),
    lon: z.number().min(-180).max(180).describe("Longitude copied from the chosen city result, or another trusted coordinate source."),
  })
  .strict();

const LocationDeleteDataSchema = z
  .object({
    locationId: WeatherLocationIdSchema,
    deleted: z.literal(true),
  })
  .strict();

const encodeCursor = (page: number, limit: number): string =>
  Buffer.from(JSON.stringify({ v: 1, page, limit }), "utf8").toString("base64url");

export const decodeWeatherCapabilityCursor = (cursor: string | undefined, limit: number, locale = "en"): Result<number> => {
  const { t } = resolveWeatherMessages(locale);
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown; limit?: unknown };
    return value.v === 1 &&
      Number.isSafeInteger(value.page) &&
      Number(value.page) >= 1 &&
      (Number(value.page) - 1) * limit <= MAX_CURSOR_OFFSET &&
      value.limit === limit
      ? ok(Number(value.page))
      : fail(err.badInput(t.capabilityInvalidCursor));
  } catch {
    return fail(err.badInput(t.capabilityInvalidCursor));
  }
};

const requireUserId = (context: CapabilityExecutionContext): Result<string> =>
  context.accessSubject.type === "user"
    ? ok(context.accessSubject.userId)
    : fail(err.forbidden(resolveWeatherMessages(context.locale).t.capabilityNeedsUser));

const locationHref = (locationId: string): string => `/app/weather/${locationId}`;

const mapLocation = (location: { id: string; name: string; state: string | null; lat: number; lon: number }) => ({
  id: location.id,
  name: location.name.trim().slice(0, 120),
  state: location.state?.trim().slice(0, 120) || null,
  lat: location.lat,
  lon: location.lon,
});

const locationPageResult = <T>(page: Paginated<unknown>, data: T, refs?: CapabilityResult<T>["refs"]): CapabilityInvocationResult<T> =>
  ok({
    data,
    ...(refs ? { refs } : {}),
    page: capabilityPage(page.hasNext ? encodeCursor(page.page + 1, page.perPage) : undefined),
  });

const runSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const { t } = resolveWeatherMessages(context.locale);
  const userId = requireUserId(context);
  if (!userId.ok) return userId;

  const page = await weatherService.location.saved.list({
    userId: userId.data,
    pagination: { page: 1, perPage: input.limit },
    filter: { query: input.query },
  });
  const data: CloudResourceView[] = page.items.map((rawEntry) => {
    const entry = mapLocation(rawEntry);
    return {
      ref: { type: "weather.location", id: entry.id },
      title: entry.name,
      preview: entry.state ?? undefined,
      icon: "ti ti-temperature-celsius",
      priority: 6,
      metadata: [
        { label: t.capabilityType, value: t.capabilityLocationValue },
        ...(entry.state ? [{ label: t.capabilityState, value: entry.state }] : []),
      ],
      links: [{ rel: "open", href: locationHref(entry.id) }],
    };
  });
  return ok({ data });
};

const runLocationList = async (input: z.infer<typeof LocationListInputSchema>, context: CapabilityExecutionContext) => {
  const { t } = resolveWeatherMessages(context.locale);
  const userId = requireUserId(context);
  if (!userId.ok) return userId;
  const cursor = decodeWeatherCapabilityCursor(input.cursor, input.limit, context.locale);
  if (!cursor.ok) return cursor;

  const page = await weatherService.location.saved.list({
    userId: userId.data,
    pagination: { page: cursor.data, perPage: input.limit },
  });
  if (page.hasNext && page.page * page.perPage > MAX_CURSOR_OFFSET) {
    return fail(err.badInput(t.capabilityPaginationExceeded));
  }
  const locations = page.items.map((location) => {
    const data = mapLocation(location);
    return {
      ...data,
      ref: { type: "weather.location" as const, id: data.id },
      links: [{ rel: "open" as const, href: locationHref(data.id) }],
    };
  });
  return locationPageResult(
    page,
    locations,
    locations.map((location) => ({ type: "weather.location", id: location.id })),
  );
};

const runLocationRead = async (input: z.infer<typeof LocationReadInputSchema>, context: CapabilityExecutionContext) => {
  const { t } = resolveWeatherMessages(context.locale);
  const userId = requireUserId(context);
  if (!userId.ok) return userId;
  const location = await weatherService.location.saved.get({ id: input.id, userId: userId.data });
  if (!location) return fail({ code: "NOT_FOUND", message: t.capabilityLocationNotFound, status: 404 });
  const data = mapLocation(location);
  return ok({
    data,
    summary: t.capabilityReadLocation({ name: data.name }),
    refs: [{ type: "weather.location", id: data.id }],
    links: [{ rel: "open" as const, href: locationHref(data.id) }],
  });
};

type ForecastSource = z.infer<typeof ForecastSourceSchema>;
type ResolvedForecastSource = { lat: string; lon: string; locationId: string | null };

const resolveForecastSource = async (
  source: ForecastSource,
  context: CapabilityExecutionContext,
): Promise<Result<ResolvedForecastSource>> => {
  if (source.kind === "coordinates") {
    return ok({ lat: String(source.lat), lon: String(source.lon), locationId: null });
  }

  const userId = requireUserId(context);
  if (!userId.ok) return userId;
  const location = await weatherService.location.saved.get({ id: source.locationId, userId: userId.data });
  return location
    ? ok({ lat: String(location.lat), lon: String(location.lon), locationId: location.id })
    : fail({ code: "NOT_FOUND", message: resolveWeatherMessages(context.locale).t.capabilityLocationNotFound, status: 404 });
};

const forecastIdentity = (locationId: string | null) =>
  locationId
    ? {
        refs: [{ type: "weather.location", id: locationId }],
        links: [{ rel: "open" as const, href: locationHref(locationId) }],
      }
    : {};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const icon = (value: unknown) => {
  const parsed = WeatherIconSchema.safeParse(value);
  return parsed.success ? parsed.data : "cloudy";
};

const currentCandidate = (value: unknown) => {
  const source = record(value);
  return {
    temperature: source.temperature,
    icon: icon(source.icon),
    cloudCover: source.cloudCover,
    windSpeed: source.windSpeed,
    windGust: source.windGust,
    windDirection: source.windDirection,
    humidity: source.humidity,
    precipitation: source.precipitation,
    pressure: source.pressure,
    visibility: source.visibility,
    dewPoint: source.dewPoint,
    sunshine: source.sunshine,
    stationName: typeof source.stationName === "string" ? source.stationName.trim().slice(0, 160) : source.stationName,
    timestamp: source.timestamp,
  };
};

const projectCurrentWeather = (value: unknown) => CurrentWeatherSchema.safeParse(currentCandidate(value));

const projectWeatherData = (value: unknown) => {
  const source = record(value);
  const hourly = Array.isArray(source.hourly)
    ? source.hourly.slice(0, 12).map((value) => {
        const entry = record(value);
        return {
          timestamp: entry.timestamp,
          temperature: entry.temperature,
          icon: icon(entry.icon),
          precipitation: entry.precipitation,
          precipitationProbability: entry.precipitationProbability,
          windSpeed: entry.windSpeed,
          cloudCover: entry.cloudCover,
        };
      })
    : source.hourly;
  const daily = Array.isArray(source.daily)
    ? source.daily.slice(0, 7).map((value) => {
        const entry = record(value);
        return {
          date: entry.date,
          icon: icon(entry.icon),
          tempMin: entry.tempMin,
          tempMax: entry.tempMax,
          precipitation: entry.precipitation,
          precipitationProbability: entry.precipitationProbability,
          sunshine: entry.sunshine,
        };
      })
    : source.daily;
  return WeatherDataSchema.safeParse({ current: currentCandidate(source.current), hourly, daily });
};

const runCurrentForecast = async (input: z.infer<typeof ForecastInputSchema>, context: CapabilityExecutionContext) => {
  const { locale, t } = resolveWeatherMessages(context.locale);
  const source = await resolveForecastSource(input.source, context);
  if (!source.ok) return source;
  try {
    const data = await weatherService.forecast.current.get({ lat: source.data.lat, lon: source.data.lon });
    if (!data) return unavailable(t);
    const projected = projectCurrentWeather(data);
    return projected.success
      ? ok({
          data: projected.data,
          summary: t.capabilityCurrentSummary({
            station: projected.data.stationName === "Unknown" ? t.unknownStation : projected.data.stationName,
            temperature: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(projected.data.temperature),
          }),
          ...forecastIdentity(source.data.locationId),
        })
      : unavailable(t);
  } catch {
    return unavailable(t);
  }
};

const runForecast = async (input: z.infer<typeof ForecastInputSchema>, context: CapabilityExecutionContext) => {
  const { t } = resolveWeatherMessages(context.locale);
  const source = await resolveForecastSource(input.source, context);
  if (!source.ok) return source;
  try {
    const data = await weatherService.forecast.get({ lat: source.data.lat, lon: source.data.lon });
    if (!data) return unavailable(t);
    const projected = projectWeatherData(data);
    return projected.success
      ? ok({
          data: projected.data,
          summary: t.capabilityForecastSummary({ station: projected.data.current.stationName }),
          ...forecastIdentity(source.data.locationId),
        })
      : unavailable(t);
  } catch {
    return unavailable(t);
  }
};

const runCitySearch = async (input: z.infer<typeof CitySearchInputSchema>, context: CapabilityExecutionContext) => {
  const { t } = resolveWeatherMessages(context.locale);
  try {
    const result = await weatherService.location.city.list({
      pagination: { page: 1, perPage: input.limit },
      signal: context.signal,
      filter: { query: input.query, country: "DE" },
    });
    if (!result.ok) return citySearchUnavailable(t);
    const data = CitySearchDataSchema.safeParse(result.data.items.slice(0, input.limit));
    return data.success ? ok({ data: data.data }) : citySearchUnavailable(t);
  } catch {
    return citySearchUnavailable(t);
  }
};

const capabilityAuditActor = (context: CapabilityExecutionContext): AuditActor =>
  context.actor.kind === "user"
    ? {
        userId: context.actor.user.id,
        uid: context.actor.user.uid,
        provider: context.actor.user.provider,
        roles: context.actor.user.roles,
      }
    : {
        uid: `service-account:${context.actor.serviceAccount.id}`,
        provider: "service_account",
        roles: context.actor.scopes,
      };

const audited = async <T>(
  params: {
    action: string;
    actor: AuditActor;
    target: { type: string; id?: string; label?: string };
    metadata: { capability: string };
  },
  operation: () => Promise<CapabilityInvocationResult<T>>,
): Promise<CapabilityInvocationResult<T>> => {
  const result = await operation();
  return result.ok ? audit.recordResultAfterSideEffect({ ...params, result }) : audit.recordResult({ ...params, result });
};

const runLocationCreate = async (input: z.infer<typeof LocationCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(
    {
      action: "weather.capability.location.create",
      actor: capabilityAuditActor(context),
      target: { type: "weather_location", label: input.name },
      metadata: { capability: "weather.location.create" },
    },
    async () => {
      const { t } = resolveWeatherMessages(context.locale);
      const userId = requireUserId(context);
      if (!userId.ok) return userId;
      const result = await weatherService.location.saved.create({ userId: userId.data, data: input });
      if (!result.ok) return fail({ ...result.error, message: t.addLocationFailed });
      const data = mapLocation(result.data);
      return ok({
        data,
        summary: t.capabilitySavedSummary({ name: data.name }),
        refs: [{ type: "weather.location", id: data.id }],
        links: [{ rel: "open" as const, href: locationHref(data.id) }],
      });
    },
  );

const runLocationDelete = async (input: z.infer<typeof LocationTargetInputSchema>, context: CapabilityExecutionContext) =>
  audited(
    {
      action: "weather.capability.location.delete",
      actor: capabilityAuditActor(context),
      target: { type: "weather_location", id: input.locationId },
      metadata: { capability: "weather.location.delete" },
    },
    async () => {
      const { t } = resolveWeatherMessages(context.locale);
      const userId = requireUserId(context);
      if (!userId.ok) return userId;
      const location = await weatherService.location.saved.get({ id: input.locationId, userId: userId.data });
      if (!location) return fail({ code: "NOT_FOUND", message: t.capabilityLocationNotFound, status: 404 });
      const result = await weatherService.location.saved.remove({ id: input.locationId, userId: userId.data });
      return result.ok
        ? ok({
            data: { locationId: input.locationId, deleted: true as const },
            summary: t.capabilityDeletedSummary({ name: mapLocation(location).name }),
          })
        : fail({ ...result.error, message: t.removeLocationFailed });
    },
  );

export const weatherCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: weatherCapabilityPresentation,
  types: {
    location: {
      title: "Saved location",
      description: "A saved weather location owned by the current user.",
      icon: "ti ti-map-pin",
      reader: "location.read",
    },
  },
  queries: {
    "location.search": {
      title: "Search saved weather locations",
      description:
        "Find an owned saved location by name or state when its ID is unknown. Use returned weather.location refs with location.read, forecast.current, or forecast.get; use city.search for unsaved places.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          {
            tag: "weather",
            title: "Weather",
            description: "Show saved weather locations.",
            aliases: ["forecast", "location", "temperature"],
          },
        ],
      },
      run: runSearch,
    },
    "location.list": {
      title: "List my saved weather locations",
      description:
        "Normal entry for browsing all saved locations. Use returned weather.location refs or IDs with location.read, forecast.current, or forecast.get; use location.search to filter by name or state.",
      input: LocationListInputSchema,
      data: z.array(LocationListItemSchema).max(100),
      openWorld: false,
      run: runLocationList,
    },
    "location.read": {
      title: "Read saved weather location",
      description: "Read one weather.location ref returned by location.list, location.search, or location.create.",
      input: LocationReadInputSchema,
      data: LocationSchema,
      openWorld: false,
      run: runLocationRead,
    },
    "forecast.current": {
      title: "Get current weather",
      description:
        "Get current conditions for a saved location ID from location.list/search or explicit coordinates from city.search. Use forecast.get when hourly or daily outlooks are needed. Units are °C, km/h, mm, hPa, and metres.",
      input: ForecastInputSchema,
      data: CurrentWeatherSchema,
      openWorld: true,
      run: runCurrentForecast,
    },
    "forecast.get": {
      title: "Get weather forecast",
      description:
        "Get current conditions plus hourly and daily outlooks for a saved location ID from location.list/search or explicit coordinates from city.search. Use forecast.current for current conditions only. Units are °C, km/h, mm, and sunshine minutes.",
      input: ForecastInputSchema,
      data: WeatherDataSchema,
      openWorld: true,
      run: runForecast,
    },
    "city.search": {
      title: "Search German cities",
      description:
        "Specialized geocoding path: find German city candidates and coordinates. To save one, copy the chosen name, optional state, lat, and lon into Save weather location; city results are not weather.location refs.",
      input: CitySearchInputSchema,
      data: CitySearchDataSchema,
      openWorld: true,
      run: runCitySearch,
    },
  },
  actions: {
    "location.create": {
      title: "Save weather location",
      description: "Save one weather location for the current user from explicit coordinates, commonly copied from Search German cities.",
      input: LocationCreateInputSchema,
      data: LocationSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const { t } = resolveWeatherMessages(context.locale);
        const userId = requireUserId(context);
        if (!userId.ok) return userId;
        return ok({
          message: t.capabilitySaveReview({ name: input.name }),
          details: [
            { label: t.location, value: input.name },
            ...(input.state ? [{ label: t.stateOrRegion, value: input.state }] : []),
            { label: t.latitude, value: String(input.lat) },
            { label: t.longitude, value: String(input.lon) },
          ],
          approvalScope: WEATHER_LOCATIONS_APPROVAL_SCOPE,
        });
      },
      run: runLocationCreate,
    },
    "location.delete": {
      title: "Delete saved weather location",
      description: "Permanently delete one saved weather location owned by the current user.",
      input: LocationTargetInputSchema,
      data: LocationDeleteDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const { t } = resolveWeatherMessages(context.locale);
        const userId = requireUserId(context);
        if (!userId.ok) return userId;
        const location = await weatherService.location.saved.get({ id: input.locationId, userId: userId.data });
        if (!location) return fail({ code: "NOT_FOUND", message: t.capabilityLocationNotFound, status: 404 });
        const name = location.name.trim().slice(0, 120);
        return ok({
          message: t.capabilityDeleteReview({ name }),
          details: [{ label: t.location, value: name }],
          links: [{ rel: "open" as const, href: locationHref(location.id) }],
        });
      },
      run: runLocationDelete,
    },
  },
});
