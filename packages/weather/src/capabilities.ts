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
import { CurrentWeatherSchema, WeatherDataSchema, WeatherIconSchema, WeatherLocationIdSchema } from "./contracts";

const MAX_CURSOR_OFFSET = 10_000;
const WEATHER_LOCATIONS_APPROVAL_SCOPE = "locations";

const unavailable = <T>(): CapabilityInvocationResult<T> =>
  fail({
    code: "WEATHER_UNAVAILABLE",
    message: "Weather data is unavailable",
    status: 500,
  });

const citySearchUnavailable = <T>(): CapabilityInvocationResult<T> =>
  fail({
    code: "WEATHER_CITY_SEARCH_UNAVAILABLE",
    message: "Weather city search is unavailable",
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

const LocationListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of saved locations to return."),
    cursor: z.string().min(1).max(2048).optional().describe("Opaque cursor returned by a previous location.list call."),
  })
  .strict();

const LocationReadInputSchema = z
  .object({
    id: WeatherLocationIdSchema.describe("Stable readable ID of the saved weather location."),
  })
  .strict();

const LocationTargetInputSchema = z
  .object({
    locationId: WeatherLocationIdSchema.describe("Stable readable ID of the saved weather location."),
  })
  .strict();

const ForecastSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("saved").describe("Use a saved location owned by the current user."),
      locationId: WeatherLocationIdSchema.describe("Stable readable ID of the saved weather location."),
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
    query: z.string().trim().min(1).max(120).describe("German city name to search for."),
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
    name: z.string().trim().min(1).max(120).describe("Display name for the saved location."),
    state: z.string().trim().min(1).max(120).optional().describe("Optional state or region used to distinguish the location."),
    lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees from -90 to 90."),
    lon: z.number().min(-180).max(180).describe("Longitude in decimal degrees from -180 to 180."),
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

export const decodeWeatherCapabilityCursor = (cursor: string | undefined, limit: number): Result<number> => {
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown; limit?: unknown };
    return value.v === 1 &&
      Number.isSafeInteger(value.page) &&
      Number(value.page) >= 1 &&
      (Number(value.page) - 1) * limit <= MAX_CURSOR_OFFSET &&
      value.limit === limit
      ? ok(Number(value.page))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const requireUserId = (context: CapabilityExecutionContext): Result<string> =>
  context.accessSubject.type === "user"
    ? ok(context.accessSubject.userId)
    : fail(err.forbidden("Weather capabilities require a user-backed actor"));

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
      metadata: [{ label: "Type", value: "Location" }, ...(entry.state ? [{ label: "State", value: entry.state }] : [])],
      links: [{ rel: "open", href: locationHref(entry.id) }],
    };
  });
  return ok({ data });
};

const runLocationList = async (input: z.infer<typeof LocationListInputSchema>, context: CapabilityExecutionContext) => {
  const userId = requireUserId(context);
  if (!userId.ok) return userId;
  const cursor = decodeWeatherCapabilityCursor(input.cursor, input.limit);
  if (!cursor.ok) return cursor;

  const page = await weatherService.location.saved.list({
    userId: userId.data,
    pagination: { page: cursor.data, perPage: input.limit },
  });
  if (page.hasNext && page.page * page.perPage > MAX_CURSOR_OFFSET) {
    return fail(err.badInput("Saved location pagination exceeds the supported window"));
  }
  const locations = page.items.map((location) => {
    const data = mapLocation(location);
    return { ...data, links: [{ rel: "open" as const, href: locationHref(data.id) }] };
  });
  return locationPageResult(
    page,
    locations,
    locations.map((location) => ({ type: "weather.location", id: location.id })),
  );
};

const runLocationRead = async (input: z.infer<typeof LocationReadInputSchema>, context: CapabilityExecutionContext) => {
  const userId = requireUserId(context);
  if (!userId.ok) return userId;
  const location = await weatherService.location.saved.get({ id: input.id, userId: userId.data });
  if (!location) return fail(err.notFound("Location"));
  const data = mapLocation(location);
  return ok({
    data,
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
  return location ? ok({ lat: String(location.lat), lon: String(location.lon), locationId: location.id }) : fail(err.notFound("Location"));
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
  const source = await resolveForecastSource(input.source, context);
  if (!source.ok) return source;
  try {
    const data = await weatherService.forecast.current.get({ lat: source.data.lat, lon: source.data.lon });
    if (!data) return unavailable();
    const projected = projectCurrentWeather(data);
    return projected.success ? ok({ data: projected.data, ...forecastIdentity(source.data.locationId) }) : unavailable();
  } catch {
    return unavailable();
  }
};

const runForecast = async (input: z.infer<typeof ForecastInputSchema>, context: CapabilityExecutionContext) => {
  const source = await resolveForecastSource(input.source, context);
  if (!source.ok) return source;
  try {
    const data = await weatherService.forecast.get({ lat: source.data.lat, lon: source.data.lon });
    if (!data) return unavailable();
    const projected = projectWeatherData(data);
    return projected.success ? ok({ data: projected.data, ...forecastIdentity(source.data.locationId) }) : unavailable();
  } catch {
    return unavailable();
  }
};

const runCitySearch = async (input: z.infer<typeof CitySearchInputSchema>, context: CapabilityExecutionContext) => {
  try {
    const result = await weatherService.location.city.list({
      pagination: { page: 1, perPage: input.limit },
      signal: context.signal,
      filter: { query: input.query, country: "DE" },
    });
    if (!result.ok) return result;
    const data = CitySearchDataSchema.safeParse(result.data.items.slice(0, input.limit));
    return data.success ? ok({ data: data.data }) : citySearchUnavailable();
  } catch {
    return citySearchUnavailable();
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
      const userId = requireUserId(context);
      if (!userId.ok) return userId;
      const result = await weatherService.location.saved.create({ userId: userId.data, data: input });
      if (!result.ok) return result;
      const data = mapLocation(result.data);
      return ok({
        data,
        summary: `Saved ${data.name} for weather forecasts.`,
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
      const userId = requireUserId(context);
      if (!userId.ok) return userId;
      const location = await weatherService.location.saved.get({ id: input.locationId, userId: userId.data });
      if (!location) return fail(err.notFound("Location"));
      const result = await weatherService.location.saved.remove({ id: input.locationId, userId: userId.data });
      return result.ok
        ? ok({
            data: { locationId: input.locationId, deleted: true as const },
            summary: `Deleted ${mapLocation(location).name} from your saved weather locations.`,
          })
        : result;
    },
  );

export const weatherCapabilities = defineCapabilities({
  protocolVersion: 1,
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
      description: "Find saved weather locations owned by the current user by name or state.",
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
      description: "List the current user's saved weather locations with bounded pagination.",
      input: LocationListInputSchema,
      data: z.array(LocationSchema).max(100),
      openWorld: false,
      run: runLocationList,
    },
    "location.read": {
      title: "Read saved weather location",
      description: "Read one saved weather location owned by the current user by stable readable ID.",
      input: LocationReadInputSchema,
      data: LocationSchema,
      openWorld: false,
      run: runLocationRead,
    },
    "forecast.current": {
      title: "Get current weather",
      description:
        "Get current weather for one owned saved location or explicit coordinates. Temperatures use degrees Celsius, wind uses km/h, precipitation uses mm, pressure uses hPa, and visibility uses metres.",
      input: ForecastInputSchema,
      data: CurrentWeatherSchema,
      openWorld: true,
      run: runCurrentForecast,
    },
    "forecast.get": {
      title: "Get weather forecast",
      description:
        "Get current conditions plus up to 12 hourly and 7 daily forecasts for one owned saved location or explicit coordinates. Temperatures use degrees Celsius, wind uses km/h, precipitation uses mm, and sunshine uses minutes.",
      input: ForecastInputSchema,
      data: WeatherDataSchema,
      openWorld: true,
      run: runForecast,
    },
    "city.search": {
      title: "Search German cities",
      description: "Find bounded German city candidates and coordinates for forecasts or saved locations.",
      input: CitySearchInputSchema,
      data: CitySearchDataSchema,
      openWorld: true,
      run: runCitySearch,
    },
  },
  actions: {
    "location.create": {
      title: "Save weather location",
      description: "Save one weather location for the current user.",
      input: LocationCreateInputSchema,
      data: LocationSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const userId = requireUserId(context);
        if (!userId.ok) return userId;
        return ok({
          message: `Save ${input.name} for weather forecasts.`,
          details: [
            { label: "Location", value: input.name },
            ...(input.state ? [{ label: "State or region", value: input.state }] : []),
            { label: "Latitude", value: String(input.lat) },
            { label: "Longitude", value: String(input.lon) },
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
        const userId = requireUserId(context);
        if (!userId.ok) return userId;
        const location = await weatherService.location.saved.get({ id: input.locationId, userId: userId.data });
        if (!location) return fail(err.notFound("Location"));
        const name = location.name.trim().slice(0, 120);
        return ok({
          message: `Permanently delete saved weather location ${name}.`,
          details: [{ label: "Location", value: name }],
          links: [{ rel: "open" as const, href: locationHref(location.id) }],
        });
      },
      run: runLocationDelete,
    },
  },
});
