import { redis } from "../../runtime/clients";

import { logger } from "../logging";
import { coreSettings } from "../settings/api";
import type { CurrentWeather, DailyForecast, HourlyForecast, WeatherData, WeatherIcon } from "./types";

const log = logger("weather");

const BRIGHTSKY_API = "https://api.brightsky.dev";
const BRIGHTSKY_TIMEOUT_MS = 400;

export type ForecastLocationConfig = {
  lat?: string;
  lon?: string;
};

type ResolvedForecastLocation = {
  lat: string;
  lon: string;
};

const resolveForecastLocation = async (config?: ForecastLocationConfig): Promise<ResolvedForecastLocation | null> => {
  const lat = (config?.lat ?? (await coreSettings.get<string>("weather.default_lat"))).trim();
  const lon = (config?.lon ?? (await coreSettings.get<string>("weather.default_lon"))).trim();

  if (!lat || !lon) {
    log.error("Weather default coordinates are not configured", {
      missing: [!lat ? "weather.default_lat" : null, !lon ? "weather.default_lon" : null].filter(Boolean),
    });
    return null;
  }

  return { lat, lon };
};

/** Brightsky current_weather API response */
type BrightskyCurrentResponse = {
  weather: {
    timestamp: string;
    source_id: number;
    cloud_cover: number | null;
    condition: string | null;
    dew_point: number | null;
    icon: WeatherIcon | null;
    precipitation_10: number | null;
    precipitation_30: number | null;
    precipitation_60: number | null;
    pressure_msl: number | null;
    relative_humidity: number | null;
    solar_10: number | null;
    solar_30: number | null;
    solar_60: number | null;
    sunshine_30: number | null;
    sunshine_60: number | null;
    temperature: number | null;
    visibility: number | null;
    wind_direction_10: number | null;
    wind_direction_30: number | null;
    wind_direction_60: number | null;
    wind_gust_direction_10: number | null;
    wind_gust_direction_30: number | null;
    wind_gust_direction_60: number | null;
    wind_gust_speed_10: number | null;
    wind_gust_speed_30: number | null;
    wind_gust_speed_60: number | null;
    wind_speed_10: number | null;
    wind_speed_30: number | null;
    wind_speed_60: number | null;
  };
  sources: Array<{
    id: number;
    dwd_station_id: string;
    station_name: string;
    lat: number;
    lon: number;
    height: number;
    distance: number;
  }>;
};

/** Brightsky weather (forecast) API response */
type BrightskyWeatherResponse = {
  weather: Array<{
    timestamp: string;
    temperature: number | null;
    icon: WeatherIcon | null;
    precipitation: number | null;
    precipitation_probability: number | null;
    wind_speed: number | null;
    cloud_cover: number | null;
    sunshine: number | null;
  }>;
  sources: Array<{
    station_name: string;
  }>;
};

/** Get cache key for location (default or custom). */
const getCacheKey = (lat: string, lon: string): string => {
  return `weather:${lat}:${lon}`;
};

/** Fetch current weather from Brightsky API. */
const fetchCurrentFromApi = async (lat: string, lon: string): Promise<CurrentWeather | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIGHTSKY_TIMEOUT_MS);

  try {
    const url = `${BRIGHTSKY_API}/current_weather?lat=${lat}&lon=${lon}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      log.error("Brightsky API error", { status: response.status });
      return null;
    }

    const data: BrightskyCurrentResponse = await response.json();

    if (!data.weather || data.weather.temperature === null) {
      log.error("Invalid Brightsky response");
      return null;
    }

    const w = data.weather;
    const source = data.sources?.[0];

    return {
      temperature: Math.round(w.temperature!),
      icon: w.icon ?? "cloudy",
      cloudCover: w.cloud_cover ?? 0,
      windSpeed: Math.round(w.wind_speed_10 ?? w.wind_speed_30 ?? 0),
      windGust: w.wind_gust_speed_10 ? Math.round(w.wind_gust_speed_10) : null,
      windDirection: w.wind_direction_10 ?? w.wind_direction_30 ?? null,
      humidity: w.relative_humidity,
      precipitation: w.precipitation_60 ?? 0,
      pressure: w.pressure_msl != null ? Math.round(w.pressure_msl) : null,
      visibility: w.visibility != null ? Math.round(w.visibility) : null,
      dewPoint: w.dew_point != null ? Math.round(w.dew_point * 10) / 10 : null,
      sunshine: w.sunshine_60 != null ? w.sunshine_60 : null,
      stationName: source?.station_name ?? "Unknown",
      timestamp: w.timestamp,
    };
  } catch (error) {
    log.error("Failed to fetch from Brightsky", {
      error: error instanceof Error ? error.message : String(error),
      timeoutMs: BRIGHTSKY_TIMEOUT_MS,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/** Get current weather, using Redis cache. */
export const getCurrentWeather = async (config?: ForecastLocationConfig): Promise<CurrentWeather | null> => {
  const location = await resolveForecastLocation(config);
  if (!location) return null;

  const { lat, lon } = location;
  const cacheKey = getCacheKey(lat, lon);

  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as CurrentWeather;
    } catch {
      // Invalid cache, will refetch
    }
  }

  const result = await fetchCurrentFromApi(lat, lon);
  if (!result) return null;

  const ttl = Math.round(((await coreSettings.get<number>("weather.cache_minutes")) ?? 30) * 60);
  await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);

  return result;
};

/** Get most common icon from array. */
const getMostCommonIcon = (icons: WeatherIcon[]): WeatherIcon => {
  if (icons.length === 0) return "cloudy";
  const counts = new Map<WeatherIcon, number>();
  for (const icon of icons) {
    counts.set(icon, (counts.get(icon) ?? 0) + 1);
  }
  let maxCount = 0;
  let result: WeatherIcon = "cloudy";
  for (const [icon, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      result = icon;
    }
  }
  return result;
};

/** Fetch weather forecast from Brightsky API. */
const fetchForecastFromApi = async (lat: string, lon: string): Promise<{ hourly: HourlyForecast[]; daily: DailyForecast[] } | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIGHTSKY_TIMEOUT_MS);

  try {
    const now = new Date();
    const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const dateStr = now.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    const url = `${BRIGHTSKY_API}/weather?lat=${lat}&lon=${lon}&date=${dateStr}&last_date=${endDateStr}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      log.error("Brightsky forecast API error", { status: response.status });
      return null;
    }

    const data: BrightskyWeatherResponse = await response.json();

    if (!data.weather || data.weather.length === 0) {
      return null;
    }

    const hourly: HourlyForecast[] = data.weather
      .filter((w) => w.temperature !== null && new Date(w.timestamp) >= now)
      .slice(0, 12)
      .map((w) => ({
        timestamp: w.timestamp,
        temperature: Math.round(w.temperature ?? 0),
        icon: w.icon ?? "cloudy",
        precipitation: w.precipitation ?? 0,
        precipitationProbability: w.precipitation_probability,
        windSpeed: Math.round(w.wind_speed ?? 0),
        cloudCover: w.cloud_cover ?? 0,
      }));

    const dailyMap = new Map<
      string,
      {
        temps: number[];
        icons: WeatherIcon[];
        precip: number;
        precipProb: number[];
        sunshine: number;
      }
    >();

    for (const w of data.weather) {
      if (w.temperature === null) continue;
      const date = w.timestamp.split("T")[0];
      if (!date) continue;
      const existing = dailyMap.get(date) ?? {
        temps: [],
        icons: [],
        precip: 0,
        precipProb: [],
        sunshine: 0,
      };
      existing.temps.push(w.temperature);
      if (w.icon) existing.icons.push(w.icon);
      existing.precip += w.precipitation ?? 0;
      if (w.precipitation_probability != null) {
        existing.precipProb.push(w.precipitation_probability);
      }
      existing.sunshine += w.sunshine ?? 0;
      dailyMap.set(date, existing);
    }

    const daily: DailyForecast[] = Array.from(dailyMap.entries())
      .slice(0, 7)
      .map(([date, day]) => ({
        date,
        tempMin: Math.round(Math.min(...day.temps)),
        tempMax: Math.round(Math.max(...day.temps)),
        icon: getMostCommonIcon(day.icons),
        precipitation: Math.round(day.precip * 10) / 10,
        precipitationProbability: day.precipProb.length > 0 ? Math.max(...day.precipProb) : null,
        sunshine: Math.round(day.sunshine),
      }));

    return { hourly, daily };
  } catch (error) {
    log.error("Failed to fetch forecast", {
      error: error instanceof Error ? error.message : String(error),
      timeoutMs: BRIGHTSKY_TIMEOUT_MS,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/** Get full weather data including forecasts. */
export const getWeatherData = async (config?: ForecastLocationConfig): Promise<WeatherData | null> => {
  const location = await resolveForecastLocation(config);
  if (!location) return null;

  const { lat, lon } = location;
  const cacheKey = `weather:full:${lat}:${lon}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as WeatherData;
    } catch {
      // Invalid cache, will refetch
    }
  }

  const [current, forecast] = await Promise.all([getCurrentWeather(location), fetchForecastFromApi(lat, lon)]);

  if (!current) return null;

  const result: WeatherData = {
    current,
    hourly: forecast?.hourly ?? [],
    daily: forecast?.daily ?? [],
  };

  const ttl = Math.round(((await coreSettings.get<number>("weather.cache_minutes")) ?? 30) * 60);
  await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);

  return result;
};
