import type { z } from "zod";
import type { AccessSubject, CapabilityExecutionContext, RequestActor } from "../../contracts";
import {
  GeoAutocompleteDataSchema,
  type GeoAutocompleteInput,
  GeoAutocompleteInputSchema,
  type GeoFunction,
  GeoGeocodeDataSchema,
  type GeoGeocodeInput,
  GeoGeocodeInputSchema,
  GeoPlaceSearchDataSchema,
  type GeoPlaceSearchInput,
  GeoPlaceSearchInputSchema,
  GeoReverseDataSchema,
  type GeoReverseInput,
  GeoReverseInputSchema,
} from "../../contracts/geo";
import { createGeoBucket, GEO_TIMEOUT_MS } from "./bucket";
import { createGeoCache, GEO_MAX_JSON_BYTES, geoCacheKey } from "./cache";
import { geoReferenceCost, geoReserveCost } from "./costs";
import { GeoError, GeoProviderError, limitExceeded } from "./errors";
import { GeoapifyAdapter } from "./geoapify";
import { createGeoLedger, geoPeriods } from "./ledger";
import { cutGeoWindow, decodePolyline6, locateOnGeoLine, simplifyGeoLine } from "./polyline";
import { createGeoRouteService } from "./route-service";
import { type GeoConfig, geoPlan, readGeoConfig } from "./settings";

export type GeoContext = Partial<Pick<CapabilityExecutionContext, "actor" | "accessSubject" | "locale" | "signal" | "requestId">>;
export const geoIdentity = (context: GeoContext): { actor: RequestActor; accessSubject: AccessSubject } => {
  const { actor, accessSubject } = context;
  if (
    !actor ||
    !accessSubject ||
    !(actor.kind === "user" ? actor.user?.id : actor.serviceAccount?.id) ||
    !(accessSubject.type === "user" ? accessSubject.userId : accessSubject.serviceAccountId)
  )
    throw new GeoError("GEO_FORBIDDEN");
  return { actor, accessSubject };
};
const bound = (name: string, value: number, min: number, max: number, integer = false) => {
  if (!Number.isFinite(value) || value > max || value < min || (integer && !Number.isInteger(value)))
    limitExceeded(name, value < min ? min : max, value);
};
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  return parsed.data;
};
const country = (value?: string) => {
  if (value !== undefined && !/^[a-z]{2}$/i.test(value)) throw new GeoError("GEO_UNSUPPORTED_OPTION");
};
const area = (value?: GeoPlaceSearchInput["area"]) => {
  if (!value) return;
  if (value.type === "circle") bound("area.radiusMeters", value.radiusMeters, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
  else {
    bound("area.west", value.west, -180, 180);
    bound("area.east", value.east, -180, 180);
    bound("area.south", value.south, -90, 90);
    bound("area.north", value.north, -90, 90);
    if (value.west >= value.east || value.south >= value.north) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  }
};
export const createGeoService = (
  options: {
    config?: () => Promise<GeoConfig>;
    now?: () => Date;
    adapter?: GeoapifyAdapter;
    cache?: ReturnType<typeof createGeoCache>;
    bucket?: ReturnType<typeof createGeoBucket>;
    ledger?: ReturnType<typeof createGeoLedger>;
  } = {},
) => {
  const now = options.now ?? (() => new Date());
  const config = options.config ?? readGeoConfig;
  const adapter = options.adapter ?? new GeoapifyAdapter({ now });
  const cache = options.cache ?? createGeoCache();
  const bucket = options.bucket ?? createGeoBucket();
  const ledger = options.ledger ?? createGeoLedger();
  const budgets = (settings: GeoConfig) => ({
    timezone: settings.timezone,
    monthlyCredits: settings.monthlyCredits,
    personDailyCredits: settings.personDailyCredits,
  });
  const recordTransition = async (event: "monthly_budget_exhausted" | "provider_key_rejected", timezone: string, context: GeoContext) => {
    const identity = geoIdentity(context);
    try {
      await ledger.recordTransition(event, timezone, { ...context, ...identity }, now());
    } catch {
      // The transaction rolls back the dedup row too, allowing the next refusal to record it.
      // Preserve the original recovery details and paid/unknown costs on audit outages.
      console.error("[geo] Audit transition could not be recorded", { event });
    }
  };
  const configured = async (context: GeoContext) => {
    geoIdentity(context);
    const value = await config();
    if (!value.apiKey.trim()) throw new GeoError("GEO_NOT_CONFIGURED");
    return value;
  };
  const paid = async <T>(
    fn: GeoFunction,
    input: unknown,
    context: GeoContext,
    settings: GeoConfig,
    schema: z.ZodType<T>,
    request: (signal: AbortSignal) => Promise<T>,
    limit?: number,
    cacheInput = input,
    empty: (value: T) => boolean = () => false,
  ): Promise<T> => {
    const identity = geoIdentity(context);
    const locale = context.locale ?? "en";
    const key = geoCacheKey(fn, cacheInput, locale);
    const hit = await cache.get(key, schema);
    if (hit !== null) return hit;
    const deadline = AbortSignal.timeout(GEO_TIMEOUT_MS[fn]);
    const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    const release = await bucket.acquire(fn, geoPlan(settings).rps);
    let reserved: Awaited<ReturnType<typeof ledger.reserve>> | undefined;
    let settlementAttempted = false;
    const reference = geoReferenceCost({ fn, limit });
    try {
      // A canceled request which has not been sent never reserves provider credit.
      signal.throwIfAborted();
      reserved = await ledger.reserve(
        identity.accessSubject,
        budgets(settings),
        geoReserveCost([{ fn, limit }]),
        fn === "places" ? "places" : "address",
        now(),
      );
      const response = await request(signal);
      settlementAttempted = true;
      await ledger.settle(reserved, reference);
      const value = schema.safeParse(response);
      if (!value.success || Buffer.byteLength(JSON.stringify({ data: response })) > GEO_MAX_JSON_BYTES)
        throw new GeoProviderError("GEO_PROVIDER_FAILED", "known");
      await cache.put(key, fn, value.data, empty(value.data));
      return value.data;
    } catch (cause) {
      let error = cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED");
      if (error.code === "GEO_BUDGET_EXHAUSTED" && error.details.scope === "cloud") {
        await recordTransition("monthly_budget_exhausted", settings.timezone, context);
      }
      if (reserved) {
        const charge = cause instanceof GeoProviderError ? cause.charge : cause instanceof GeoError ? "known" : "unknown";
        let settled = charge === "known" ? reference : 0;
        let unknown = charge === "unknown" ? reserved.cost : 0;
        if (!settlementAttempted) {
          settlementAttempted = true;
          try {
            await ledger.settle(reserved, charge === "none" ? 0 : charge === "unknown" ? reserved.cost : reference);
          } catch {
            settled = 0;
            unknown = reserved.cost;
          }
        }
        if (error.code === "GEO_PROVIDER_FAILED" || error.code === "GEO_BUSY")
          error = new GeoError(error.code, {
            ...error.details,
            costs: { settledCredits: settled / 1000, unknownCredits: unknown / 1000 },
          });
      }
      if (cause instanceof GeoProviderError && cause.keyRejected) {
        await recordTransition("provider_key_rejected", settings.timezone, context);
      }
      throw error;
    } finally {
      await release();
    }
  };
  const routes = createGeoRouteService({ configured, adapter, cache, bucket, ledger, now, recordTransition });
  return {
    ...routes,
    async autocomplete(input: GeoAutocompleteInput, context: GeoContext) {
      const settings = await configured(context);
      const value = parse(GeoAutocompleteInputSchema, input);
      bound("text", value.text.length, 3, 300);
      bound("text", value.text.trim().length, 3, 300);
      bound("limit", value.limit ?? 5, 1, 5, true);
      country(value.countryCode);
      area(value.area);
      return paid(
        "autocomplete",
        value,
        context,
        settings,
        GeoAutocompleteDataSchema,
        (signal) => adapter.autocomplete(value, settings.apiKey, context.locale ?? "en", signal),
        value.limit,
        { ...value, limit: value.limit ?? 5 },
        (result) => !result.suggestions.length,
      );
    },
    async geocode(input: GeoGeocodeInput, context: GeoContext) {
      const settings = await configured(context);
      const value = parse(GeoGeocodeInputSchema, input);
      if (value.text !== undefined) {
        bound("text", value.text.length, 1, 300);
        bound("text", value.text.trim().length, 1, 300);
      }
      for (const [name, field] of Object.entries(value.fields ?? {}))
        if (field !== undefined) bound(`fields.${name}`, field.length, 0, 200);
      country(value.countryCode);
      if (!!value.text?.trim() === !!Object.values(value.fields ?? {}).some((v) => v?.trim())) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      return paid("geocode", value, context, settings, GeoGeocodeDataSchema, async (signal) => {
        const result = await adapter.geocode(value, settings.apiKey, context.locale ?? "en", signal);
        if (!result.candidates.length) throw new GeoError("GEO_ADDRESS_NOT_FOUND");
        if (result.candidates.length > 1) throw new GeoError("GEO_ADDRESS_AMBIGUOUS", { candidates: result.candidates });
        return { address: result.candidates[0]!, provenance: result.provenance };
      });
    },
    async reverse(input: GeoReverseInput, context: GeoContext) {
      const settings = await configured(context);
      const value = parse(GeoReverseInputSchema, input);
      return paid("reverse", value, context, settings, GeoReverseDataSchema, async (signal) => {
        const result = await adapter.reverse(value, settings.apiKey, context.locale ?? "en", signal);
        if (!result.address) throw new GeoError("GEO_ADDRESS_NOT_FOUND");
        return { address: result.address, provenance: result.provenance };
      });
    },
    async searchPlaces(input: GeoPlaceSearchInput, context: GeoContext) {
      const settings = await configured(context);
      const value = parse(GeoPlaceSearchInputSchema, input);
      bound("categories", value.categories.length, 1, 5, true);
      bound("limit", value.limit ?? 20, 1, 20, true);
      area(value.area);
      const along = value.along;
      if (along) {
        bound("along.windowKm", along.toKm - along.fromKm, Number.MIN_VALUE, 200);
        bound("along.fromKm", along.fromKm, 0, Number.MAX_SAFE_INTEGER);
        bound("along.bufferMeters", along.bufferMeters ?? 1000, 100, 5000);
      }
      if ([value.near, value.area, value.along].filter(Boolean).length !== 1) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      const cut = along ? cutGeoWindow(decodePolyline6(along.polyline6), along.fromKm * 1000, along.toKm * 1000) : undefined;
      const simplified = cut ? simplifyGeoLine(cut) : undefined;
      const cacheInput = {
        ...value,
        limit: value.limit ?? 20,
        categories: [...new Set(value.categories)],
        ...(along ? { along: { ...along, bufferMeters: along.bufferMeters ?? 1000 } } : {}),
      };
      return paid<z.infer<typeof GeoPlaceSearchDataSchema>>(
        "places",
        value,
        context,
        settings,
        GeoPlaceSearchDataSchema,
        async (signal) => {
          // Radial reduction and Douglas–Peucker can each move the line by one tolerance.
          // Widen the provider corridor to cover the original cut; filter locally with the requested buffer.
          const providerInput =
            along && simplified
              ? {
                  ...value,
                  // Twenty provider candidates still cost one credit; apply the caller's limit after local filtering.
                  limit: 20,
                  along: {
                    ...along,
                    bufferMeters: Math.min(100000, Math.ceil((along.bufferMeters ?? 1000) + 2 * simplified.toleranceMeters)),
                  },
                }
              : value;
          const result = await adapter.places(providerInput, settings.apiKey, context.locale ?? "en", signal, simplified?.line);
          if (!cut || !along) return result;
          const places = result.places
            .map((place) => {
              const position = locateOnGeoLine(place.point, cut);
              return { ...place, ...position, atMeters: along.fromKm * 1000 + position.atMeters };
            })
            .filter((place) => place.distanceToRouteMeters <= (along.bufferMeters ?? 1000))
            .sort((a, b) => a.atMeters - b.atMeters);
          return {
            ...result,
            places: places.slice(0, value.limit ?? 20),
            simplificationToleranceMeters: simplified!.toleranceMeters,
            truncated: result.places.length === 20 && places.length < (value.limit ?? 20),
          };
        },
        value.limit,
        cacheInput,
        (result) => !result.places.length,
      );
    },
    async availability(context: GeoContext) {
      const { accessSubject } = geoIdentity(context);
      const settings = await config();
      if (!settings.apiKey.trim()) {
        const periods = geoPeriods(now(), settings.timezone);
        return {
          configured: false,
          person: { exhausted: false, resetsAt: periods.person.resetsAt },
          cloud: { exhausted: false, resetsAt: periods.cloud.resetsAt },
        };
      }
      return { configured: true, ...(await ledger.availability(accessSubject, budgets(settings), now())) };
    },
  };
};
export const coreGeo = createGeoService();
