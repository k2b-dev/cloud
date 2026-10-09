import { err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { type GeoPlace, geoService } from "../../server";
import * as settings from "../settings";

export const WEATHER_COUNTRY_CODE = "DE";

export type WeatherCity = {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  state?: string;
};

const unavailable = <T>(): Result<T> =>
  fail({
    code: "WEATHER_CITY_SEARCH_UNAVAILABLE",
    message: "Weather city search is unavailable",
    status: 500,
  });

/**
 * Adapts generic geo place data to the weather app's city model.
 */
const mapPlace = (place: GeoPlace): WeatherCity => ({
  name: place.name,
  lat: place.lat,
  lon: place.lon,
  country: place.country,
  state: place.state,
});

/**
 * Resolves and validates the configured geo service base URL.
 */
const getGeoBaseUrl = async (): Promise<Result<string>> => {
  const geoUrl = (await settings.get<string>("weather.geo_url")).trim();
  if (!geoUrl) {
    return fail({
      code: "WEATHER_CITY_SEARCH_NOT_CONFIGURED",
      message: "Geo API URL is not configured. Set weather.geo_url.",
      status: 500,
    });
  }
  return ok(geoUrl.replace(/\/$/, ""));
};

/**
 * Searches city candidates via the geo backend and enforces weather-specific country constraints.
 */
const list = async (config: {
  pagination?: PageParams;
  signal?: AbortSignal;
  filter: {
    query: string;
    country?: string;
  };
}): Promise<Result<Paginated<WeatherCity>>> => {
  const query = config.filter.query.trim();
  if (!query) {
    return ok({
      items: [],
      page: config.pagination?.page ?? 1,
      perPage: config.pagination?.perPage ?? 20,
      total: 0,
      hasNext: false,
    });
  }

  const requestedCountry = config.filter.country?.trim().toUpperCase() ?? WEATHER_COUNTRY_CODE;
  if (requestedCountry !== WEATHER_COUNTRY_CODE) {
    return fail(err.badInput("Only German city search is supported (country=DE)."));
  }

  const baseUrlResult = await getGeoBaseUrl();
  if (!baseUrlResult.ok) return baseUrlResult;
  const geoUrl = baseUrlResult.data;
  const result = await geoService.place.list({
    baseUrl: geoUrl,
    pagination: config.pagination,
    signal: config.signal,
    filter: {
      query,
      country: WEATHER_COUNTRY_CODE,
      featureClass: "P",
    },
  });
  if (!result.ok) return unavailable();

  return ok({
    ...result.data,
    items: result.data.items.map(mapPlace),
  });
};

/**
 * Resolves one place by coordinates via the geo backend.
 */
const get = async (config: { lat: number; lon: number }): Promise<Result<WeatherCity | null>> => {
  const baseUrlResult = await getGeoBaseUrl();
  if (!baseUrlResult.ok) return baseUrlResult;
  const result = await geoService.place.get({
    baseUrl: baseUrlResult.data,
    lat: config.lat,
    lon: config.lon,
  });
  if (!result.ok) return result;

  const place = result.data;
  if (!place) return ok(null);
  if (place.featureClass !== undefined && place.featureClass !== "P") {
    return ok(null);
  }

  return ok(mapPlace(place));
};

export const weatherCityService = {
  list,
  get,
};

export type WeatherCityService = typeof weatherCityService;
