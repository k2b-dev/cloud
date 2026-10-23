import { err, fail, ok } from "@k2b/stdlib";
import type { CapabilityCaller } from "../../capabilities/server";
import { registerSettings, toLegacySettingDefs } from "../settings/defaults";
import { getCurrentWeather, getWeatherData } from "./forecast";
import { WEATHER_COUNTRY_CODE } from "./geo";
import { weatherLocationService } from "./location";
import { weatherLocationsService } from "./locations";
import { WEATHER_SETTINGS } from "./settings";
import { weatherUiService } from "./ui";

registerSettings(toLegacySettingDefs(WEATHER_SETTINGS));

/**
 * Resolves a city name to coordinates and returns weather for the first match.
 */
const getByCityName = async (config: { query: string; caller: CapabilityCaller }) => {
  const query = config.query.trim();
  if (!query) {
    return fail(err.badInput("City query is required"));
  }

  const cityResult = await weatherLocationService.city.list({
    caller: config.caller,
    pagination: { page: 1, perPage: 1 },
    filter: {
      query,
      country: WEATHER_COUNTRY_CODE,
    },
  });
  if (!cityResult.ok) return cityResult;

  const city = cityResult.data.items[0];
  if (!city) {
    return fail(err.notFound("City"));
  }

  const weather = await getWeatherData({
    lat: String(city.lat),
    lon: String(city.lon),
  });
  if (!weather) {
    return fail(err.notFound("Weather data for city"));
  }

  return ok(weather);
};

export const weatherService = {
  forecast: {
    get: getWeatherData,
    current: {
      get: getCurrentWeather,
    },
    getByCityName,
  },
  location: weatherLocationService,
  locations: weatherLocationsService,
  ui: weatherUiService,
};

export type WeatherService = typeof weatherService;
export type {
  CurrentWeather,
  DailyForecast,
  HourlyForecast,
  WeatherData,
  WeatherIcon,
} from "./types";
