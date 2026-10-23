import { err, fail, ok, type PageParams } from "@k2b/stdlib";
import { geoClient } from "../../capabilities/geo-client";
import type { CapabilityCaller } from "../../capabilities/server";
import type { GeoProvenance } from "../../contracts/geo";

export const WEATHER_COUNTRY_CODE = "DE";
export type WeatherCity = { name: string; lat: number; lon: number; country?: string; state?: string; provenance: GeoProvenance };

/** Weather adapts Core's public address contract; only Core owns provider access and budgets. */
const list = async (config: {
  caller: CapabilityCaller;
  pagination?: PageParams;
  signal?: AbortSignal;
  filter: { query: string; country?: string };
}) => {
  const query = config.filter.query.trim();
  const page = config.pagination?.page ?? 1;
  const perPage = Math.min(5, config.pagination?.perPage ?? 5);
  if ((config.filter.country?.trim().toUpperCase() ?? WEATHER_COUNTRY_CODE) !== WEATHER_COUNTRY_CODE)
    return fail(err.badInput("Only German city search is supported (country=DE)."));
  if (query.length < 3 || page > 1) return ok({ items: [], page, perPage, total: 0, hasNext: false });
  const result = await geoClient.autocomplete(
    { text: query, countryCode: WEATHER_COUNTRY_CODE, type: "city", limit: perPage },
    {
      ...config.caller,
      signal: config.signal ?? config.caller.signal,
    },
  );
  if (!result.ok) return result;
  const items = result.data.data.suggestions.map((address) => ({
    name: address.city || address.formatted,
    lat: address.point.lat,
    lon: address.point.lon,
    country: address.countryCode,
    provenance: address.provenance,
    ...(address.stateRegion ? { state: address.stateRegion } : {}),
  }));
  return ok({ items, page, perPage, total: items.length, hasNext: false });
};
export const weatherCityService = { list };
export type WeatherCityService = typeof weatherCityService;
