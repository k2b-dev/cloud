import { z } from "zod";
import { readBoundedJson } from "../../_internal/bounded-json";
import {
  GEO_CATEGORIES,
  type GeoAddress,
  type GeoAutocompleteInput,
  type GeoFunction,
  type GeoGeocodeInput,
  type GeoPlace,
  type GeoPlaceSearchInput,
  type GeoPoint,
  type GeoProvenance,
  type GeoReverseInput,
} from "../../contracts/geo";
import type { GeoRouteOptions, GeoRouteResolvedStop } from "../../contracts/geo-route";
import { EMPTY_NETWORK_ALLOWLIST } from "../../shared/network-address";
import { createAllowedNetworkFetch } from "../allowed-network-fetch";
import { GEO_TIMEOUT_MS } from "./bucket";
import { GEO_MAX_JSON_BYTES, GEO_MAX_ROUTE_RESPONSE_BYTES } from "./cache";
import { GeoError } from "./errors";
import { parseGeoapifyRoute } from "./geoapify-route";

const GEOAPIFY_ORIGIN = "https://api-eu.geoapify.com";
const guardedFetch = createAllowedNetworkFetch(EMPTY_NETWORK_ALLOWLIST);
export type GeoFetch = (url: URL, init: RequestInit) => Promise<Response>;
export class GeoProviderError extends GeoError {
  constructor(
    code: "GEO_PROVIDER_FAILED" | "GEO_BUSY",
    readonly charge: "none" | "known" | "unknown",
    readonly keyRejected = false,
    readonly referenceDistanceMeters?: number,
  ) {
    super(code, {
      ...(code === "GEO_BUSY" ? { retryAfterSeconds: 1 } : {}),
      ...(keyRejected ? { adminHint: "Geoapify rejected the key. Check geo.api_key in Core settings." } : {}),
    });
  }
}
const text = z.string().max(300).optional();
const rawProperties = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  address_line1: text,
  postcode: text,
  city: text,
  town: text,
  village: text,
  state: text,
  region: text,
  country_code: z.string().max(2).optional(),
  formatted: z.string().max(600).optional(),
  street: text,
  housenumber: text,
  name: text,
  rank: z
    .object({
      confidence: z.number().min(0).max(1).optional(),
      confidence_building_level: z.number().min(0).max(1).optional(),
      match_type: z.string().optional(),
    })
    .optional(),
  result_type: z.string().optional(),
  place_id: z.string().min(1).max(2048).optional(),
  categories: z.array(z.string().max(100)).max(20).optional(),
  distance: z.number().nonnegative().optional(),
  opening_hours: z.string().max(1000).optional(),
  website: z.string().max(1000).optional(),
  contact: z.object({ phone: text }).optional(),
  datasource: z
    .object({
      raw: z.object({ opening_hours: z.string().max(1000).optional(), website: z.string().max(1000).optional(), phone: text }).optional(),
    })
    .optional(),
});
type RawProperties = z.infer<typeof rawProperties>;
const collection = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        properties: rawProperties,
        geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable(),
      }),
    )
    .max(20),
});
export const geoProvenance = (now: Date): GeoProvenance => ({
  provider: "geoapify",
  attribution: { text: "Geoapify · OpenStreetMap", links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"] },
  computedAt: now.toISOString(),
});
const address = (p: RawProperties, provenance: GeoProvenance): GeoAddress => ({
  line1: p.address_line1 ?? [p.street, p.housenumber].filter(Boolean).join(" "),
  postalCode: p.postcode ?? "",
  city: p.city ?? p.town ?? p.village ?? "",
  stateRegion: p.state ?? p.region ?? "",
  countryCode: p.country_code?.toUpperCase() ?? "",
  point: { lat: p.lat, lon: p.lon },
  formatted: p.formatted ?? p.address_line1 ?? "",
  confidence: p.rank?.confidence ?? null,
  buildingConfidence: p.rank?.confidence_building_level ?? null,
  provenance,
});
const areaFilter = (area: NonNullable<GeoAutocompleteInput["area"]>) =>
  area.type === "bbox"
    ? `rect:${area.west},${area.south},${area.east},${area.north}`
    : `circle:${area.point.lon},${area.point.lat},${area.radiusMeters}`;
/** Only these transport failures prove no HTTP request could have been delivered. Never retry resets, timeouts or aborts. */
export const geoNeverSent = (error: unknown): boolean => {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  return (
    parsed.success &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(parsed.data.code)
  );
};
export class GeoapifyAdapter {
  constructor(private readonly options: { fetch?: GeoFetch; now?: () => Date } = {}) {}
  private async requestJson(
    fn: GeoFunction,
    params: URLSearchParams,
    key: string,
    locale: string,
    callerSignal?: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(
      fn === "route" ? "/v1/routing" : fn === "places" ? "/v2/places" : `/v1/geocode/${fn === "geocode" ? "search" : fn}`,
      GEOAPIFY_ORIGIN,
    );
    const lang = new Intl.Locale(locale).language;
    params.set("lang", lang);
    params.set("format", fn === "route" ? "json" : "geojson");
    // Places v2 has one GeoJSON representation and does not accept a format parameter.
    if (fn === "places") params.delete("format");
    url.search = params.toString();
    const deadline = AbortSignal.timeout(GEO_TIMEOUT_MS[fn]);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      credentials: "omit",
      redirect: "error",
      signal,
      headers: { "x-api-key": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify({ ...z.record(z.string(), z.unknown()).parse(body), lang }) } : {}),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new GeoProviderError("GEO_PROVIDER_FAILED", "none");
      let response: Response;
      try {
        response = await (this.options.fetch ?? guardedFetch)(url, init);
      } catch (error) {
        const neverSent = !signal.aborted && geoNeverSent(error);
        if (neverSent && attempt === 0) continue;
        throw new GeoProviderError("GEO_PROVIDER_FAILED", neverSent ? "none" : "unknown");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new GeoProviderError(
          response.status === 429 ? "GEO_BUSY" : "GEO_PROVIDER_FAILED",
          "known",
          [401, 403].includes(response.status),
        );
      }
      // Bound raw provider responses; routing geometry is compacted to the smaller public result budget.
      const json = await readBoundedJson(response, fn === "route" ? GEO_MAX_ROUTE_RESPONSE_BYTES : GEO_MAX_JSON_BYTES);
      if (signal.aborted) throw new GeoProviderError("GEO_PROVIDER_FAILED", "unknown");
      if (!json.ok || JSON.stringify(json.data).includes(JSON.stringify(key).slice(1, -1)))
        throw new GeoProviderError("GEO_PROVIDER_FAILED", fn === "route" ? "unknown" : "known");
      return json.data;
    }
    throw new GeoProviderError("GEO_PROVIDER_FAILED", "none");
  }
  private async request(fn: GeoFunction, params: URLSearchParams, key: string, locale: string, signal?: AbortSignal, body?: unknown) {
    const parsed = collection.safeParse(await this.requestJson(fn, params, key, locale, signal, body));
    if (!parsed.success) throw new GeoProviderError("GEO_PROVIDER_FAILED", "known");
    return parsed.data.features.map((feature) => feature.properties);
  }
  async route(
    stops: readonly GeoRouteResolvedStop[],
    options: GeoRouteOptions,
    optimize: boolean,
    key: string,
    locale: string,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      waypoints: stops.map((stop) => `${stop.point.lat},${stop.point.lon}`).join("|"),
      mode: options.mode === "bike" ? "bicycle" : options.mode === "walk" ? "walk" : "drive",
      units: "metric",
      traffic: "free_flow",
      intermediate_waypoint_mode: "stopover",
      optimize_stops: String(optimize),
    });
    if (options.avoid?.length) params.set("avoid", options.avoid.join("|"));
    return parseGeoapifyRoute(await this.requestJson("route", params, key, locale, signal), stops, options, optimize, this.provenance());
  }
  private provenance() {
    return geoProvenance((this.options.now ?? (() => new Date()))());
  }
  async autocomplete(input: GeoAutocompleteInput, key: string, locale: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ text: input.text, limit: String(input.limit ?? 5) });
    if (input.type) params.set("type", input.type);
    const filters = [
      input.countryCode ? `countrycode:${input.countryCode.toLowerCase()}` : null,
      input.area ? areaFilter(input.area) : null,
    ].filter((v) => v !== null);
    if (filters.length) params.set("filter", filters.join("|"));
    if (input.bias) params.set("bias", `proximity:${input.bias.lon},${input.bias.lat}`);
    const values = await this.request("autocomplete", params, key, locale, signal);
    const provenance = this.provenance();
    return { suggestions: values.slice(0, input.limit ?? 5).map((p) => address(p, provenance)), provenance };
  }
  async geocode(input: GeoGeocodeInput, key: string, locale: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ limit: "5" });
    if (input.text) params.set("text", input.text);
    if (input.fields)
      for (const [field, name] of [
        ["line1", "street"],
        ["postalCode", "postcode"],
        ["city", "city"],
        ["stateRegion", "state"],
        ["country", "country"],
      ] as const) {
        const value = input.fields[field];
        if (value) params.set(name, value);
      }
    if (input.countryCode) params.set("filter", `countrycode:${input.countryCode.toLowerCase()}`);
    const raw = await this.request("geocode", params, key, locale, signal);
    const provenance = this.provenance();
    // No unverified uniqueness claim: all candidates with confidence >= .5 are plausible.
    const candidates = raw
      .slice(0, 5)
      .filter((p) => (p.rank?.confidence ?? 0) >= 0.5)
      .map((p) => address(p, provenance));
    return { candidates, provenance };
  }
  async reverse(input: GeoReverseInput, key: string, locale: string, signal?: AbortSignal) {
    const raw = await this.request(
      "reverse",
      new URLSearchParams({ lat: String(input.point.lat), lon: String(input.point.lon), limit: "1" }),
      key,
      locale,
      signal,
    );
    const provenance = this.provenance();
    return { address: raw[0] ? address(raw[0], provenance) : null, provenance };
  }
  async places(input: GeoPlaceSearchInput, key: string, locale: string, signal?: AbortSignal, line?: readonly GeoPoint[]) {
    const categories = input.categories.map((category) => GEO_CATEGORIES[category]);
    const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
    let body: unknown;
    if (input.along && line)
      body = {
        categories,
        limit: input.limit ?? 20,
        filter: {
          type: "polyline",
          geometry: { type: "LineString", coordinates: line.map((p) => [p.lon, p.lat]) },
          buffer: input.along.bufferMeters ?? 1000,
        },
      };
    else {
      params.set("categories", categories.join(","));
      if (input.near) params.set("bias", `proximity:${input.near.lon},${input.near.lat}`);
      if (input.area) params.set("filter", areaFilter(input.area));
    }
    const raw = await this.request("places", params, key, locale, signal, body);
    const provenance = this.provenance();
    const places: GeoPlace[] = raw.slice(0, input.limit ?? 20).map((p) => {
      if (!p.place_id) throw new GeoProviderError("GEO_PROVIDER_FAILED", "known");
      return {
        id: p.place_id,
        name: p.name ?? p.address_line1 ?? "",
        categories: p.categories ?? [],
        point: { lat: p.lat, lon: p.lon },
        address: address(p, provenance),
        distanceMeters: p.distance,
        openingHours: p.opening_hours ?? p.datasource?.raw?.opening_hours,
        website: p.website ?? p.datasource?.raw?.website,
        phone: p.contact?.phone ?? p.datasource?.raw?.phone,
        provenance,
      };
    });
    return { places, provenance };
  }
}
