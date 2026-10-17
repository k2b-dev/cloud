import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { readBoundedJson } from "../../_internal/bounded-json";
import { env } from "../../config/env";
import { createAllowedNetworkFetch } from "../../services/allowed-network-fetch";
import { logger } from "../../services/logging";
import { NetworkTargetBlockedError } from "../../services/network-security";
import { parseNetworkAllowlistEnv } from "../../shared/network-address";

export const geoAllowlist = () => parseNetworkAllowlistEnv("GEO_ALLOWED_TARGETS", env.GEO_ALLOWED_TARGETS);

const GEO_TIMEOUT_MS = 2_000;
const GEO_MAX_RESPONSE_BYTES = 256 * 1024;
const GEO_MAX_PLACES = 500;

const GeoApiPlaceSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    country_code: z.string().trim().max(16).optional(),
    admin1_code: z.string().trim().max(160).optional(),
    feature_class: z.string().trim().max(16).optional(),
    feature_code: z.string().trim().max(32).optional(),
  })
  .strip();

const GeoApiSearchResponseSchema = z
  .object({
    places: z.array(z.unknown()).max(GEO_MAX_PLACES).optional(),
  })
  .strip();

type GeoApiPlace = z.infer<typeof GeoApiPlaceSchema>;

export type GeoPlace = {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  state?: string;
  featureClass?: string;
  featureCode?: string;
};

/**
 * Normalizes and validates geo API base URLs before outbound requests.
 */
const normalizeBaseUrl = (baseUrl: string): Result<string> => {
  const value = baseUrl.trim();
  if (!value) {
    return fail(err.badInput("Geo API base URL is required"));
  }
  return ok(value.replace(/\/$/, ""));
};

const unavailable = <T>(): Result<T> =>
  fail({
    code: "GEO_UNAVAILABLE",
    message: "Geo service is unavailable",
    status: 500,
  });

const geoSignal = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(GEO_TIMEOUT_MS)]) : AbortSignal.timeout(GEO_TIMEOUT_MS);

const readGeoResponse = async (response: Response): Promise<Result<z.infer<typeof GeoApiSearchResponseSchema>>> => {
  const body = await readBoundedJson(response, GEO_MAX_RESPONSE_BYTES);
  if (!body.ok) return unavailable();
  const parsed = GeoApiSearchResponseSchema.safeParse(body.data);
  return parsed.success ? ok(parsed.data) : unavailable();
};

/**
 * Maps one geo API place record to the internal place model and drops invalid rows.
 */
const toPlace = (place: GeoApiPlace): GeoPlace | null => {
  if (typeof place.name !== "string" || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    return null;
  }

  return {
    name: place.name,
    lat: place.latitude,
    lon: place.longitude,
    country: place.country_code,
    state: place.admin1_code,
    featureClass: place.feature_class,
    featureCode: place.feature_code,
  };
};

/**
 * Searches places through the configured geo API and returns paginated, normalized matches.
 */
const list = async (config: {
  baseUrl: string;
  pagination?: PageParams;
  signal?: AbortSignal;
  filter: {
    query: string;
    country?: string;
    featureClass?: string;
    featureCode?: string;
  };
}): Promise<Result<Paginated<GeoPlace>>> => {
  const query = config.filter.query.trim();
  if (!query) {
    const { page, perPage } = paginate(config.pagination);
    return ok({
      items: [],
      page,
      perPage,
      total: 0,
      hasNext: false,
    });
  }

  const baseUrlResult = normalizeBaseUrl(config.baseUrl);
  if (!baseUrlResult.ok) return baseUrlResult;

  const params = new URLSearchParams({ q: query });
  if (config.filter.country?.trim()) {
    params.set("country", config.filter.country.trim());
  }

  try {
    const res = await createAllowedNetworkFetch(geoAllowlist())(`${baseUrlResult.data}/geo/search?${params}`, {
      signal: geoSignal(config.signal),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return unavailable();
    }

    const body = await readGeoResponse(res);
    if (!body.ok) return body;
    const mapped = (body.data.places ?? [])
      .flatMap((candidate) => {
        const place = GeoApiPlaceSchema.safeParse(candidate);
        return place.success ? [place.data] : [];
      })
      .map(toPlace)
      .filter((place): place is GeoPlace => place !== null);

    const filtered = mapped.filter((place) => {
      if (config.filter.featureClass && place.featureClass !== config.filter.featureClass) {
        return false;
      }
      if (config.filter.featureCode && place.featureCode !== config.filter.featureCode) {
        return false;
      }
      return true;
    });

    const { page, perPage, offset } = paginate(config.pagination);
    const items = filtered.slice(offset, offset + perPage);
    return ok({
      items,
      page,
      perPage,
      total: filtered.length,
      hasNext: page * perPage < filtered.length,
    });
  } catch (error) {
    if (error instanceof NetworkTargetBlockedError)
      logger("geo").warn("Geo target is on an internal network. An operator can allow it with GEO_ALLOWED_TARGETS.");
    return unavailable();
  }
};

/**
 * Resolves one place by coordinates via reverse geocoding.
 */
const get = async (config: { baseUrl: string; lat: number; lon: number }): Promise<Result<GeoPlace | null>> => {
  const baseUrlResult = normalizeBaseUrl(config.baseUrl);
  if (!baseUrlResult.ok) return baseUrlResult;

  try {
    const res = await createAllowedNetworkFetch(geoAllowlist())(`${baseUrlResult.data}/geo/reverse?lat=${config.lat}&lng=${config.lon}`, {
      signal: geoSignal(),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return unavailable();
    }

    const body = await readGeoResponse(res);
    if (!body.ok) return body;
    const first = (body.data.places ?? [])
      .flatMap((candidate) => {
        const place = GeoApiPlaceSchema.safeParse(candidate);
        return place.success ? [place.data] : [];
      })
      .map(toPlace)
      .find((place): place is GeoPlace => place !== null);

    return ok(first ?? null);
  } catch (error) {
    if (error instanceof NetworkTargetBlockedError)
      logger("geo").warn("Geo target is on an internal network. An operator can allow it with GEO_ALLOWED_TARGETS.");
    return unavailable();
  }
};

export const geoService = {
  place: {
    list,
    get,
  },
};

export type GeoService = typeof geoService;

export const geo = geoService;
