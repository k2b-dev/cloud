import type { z } from "zod";
import type { GeoFunction } from "../../contracts/geo";
import type { createGeoBucket } from "./bucket";
import { GEO_TIMEOUT_MS } from "./bucket";
import type { createGeoCache } from "./cache";
import { geoCacheKey } from "./cache";
import { geoReferenceCost } from "./costs";
import { GeoError, limitExceeded } from "./errors";
import { GeoProviderError } from "./geoapify";
import type { createGeoLedger } from "./ledger";
import { geoRouteReferenceCost } from "./route-costs";
import type { GeoContext } from "./service";
import { type GeoConfig, geoPlan } from "./settings";

export type GeoRouteChainDependencies = {
  cache: ReturnType<typeof createGeoCache>;
  bucket: ReturnType<typeof createGeoBucket>;
  ledger: ReturnType<typeof createGeoLedger>;
  now: () => Date;
  recordTransition: (event: "monthly_budget_exhausted" | "provider_key_rejected", timezone: string, context: GeoContext) => Promise<void>;
};
export type GeoRouteCallPricing = { pairs: number; avoids: number; optimize: boolean; distanceAllowanceMeters: number };
export const reserveRouteCall = (pricing: GeoRouteCallPricing) =>
  geoRouteReferenceCost({ ...pricing, distanceMeters: pricing.pairs * pricing.distanceAllowanceMeters });
export type GeoRouteChainCall = <V>(
  fn: GeoFunction,
  input: unknown,
  schema: z.ZodType<V>,
  request: (signal: AbortSignal) => Promise<V>,
  pricing?: GeoRouteCallPricing,
  distance?: (value: V) => number,
) => Promise<V>;
export const runGeoRouteChain = async <T>(
  dependencies: GeoRouteChainDependencies,
  context: GeoContext,
  config: GeoConfig,
  reserveCost: number,
  work: (call: GeoRouteChainCall) => Promise<T>,
): Promise<T> => {
  const { ledger, bucket, cache, now } = dependencies;
  if (!context.accessSubject) throw new GeoError("GEO_FORBIDDEN");
  context.signal?.throwIfAborted();
  const maximumCredits = Math.min(config.personDailyCredits, config.monthlyCredits);
  if (reserveCost > maximumCredits * 1000) limitExceeded("reservationCredits", maximumCredits, reserveCost / 1000);
  let reservation: Awaited<ReturnType<typeof ledger.reserve>>;
  try {
    // One atomic admission for all known geocodes and every possible paid routing step.
    reservation = await ledger.reserve(context.accessSubject, config, reserveCost, "routing", now());
  } catch (error) {
    if (error instanceof GeoError && error.code === "GEO_BUDGET_EXHAUSTED" && error.details.scope === "cloud")
      await dependencies.recordTransition("monthly_budget_exhausted", config.timezone, context);
    throw error;
  }
  let known = 0,
    unknown = 0;
  let result: T | undefined, failure: unknown;
  try {
    result = await work(async (fn, input, schema, request, pricing, distance) => {
      context.signal?.throwIfAborted();
      const key = geoCacheKey(fn, input, context.locale ?? "en");
      const hit = await cache.get(key, schema);
      if (hit !== null) {
        // A cached response still must respect this call's reference allowance.
        if (pricing && distance && distance(hit) > pricing.pairs * pricing.distanceAllowanceMeters)
          throw new GeoError("GEO_COST_OVERRUN", {
            distanceAllowanceMeters: pricing.distanceAllowanceMeters,
            actualDistanceMeters: distance(hit),
          });
        return hit;
      }
      const allocated = pricing ? reserveRouteCall(pricing) : geoReferenceCost({ fn });
      const debitKnown = (meters: number) => {
        try {
          const cost = pricing ? geoRouteReferenceCost({ ...pricing, distanceMeters: meters }) : allocated;
          if (!Number.isSafeInteger(known + unknown + cost)) throw new Error("Unrepresentable reference cost");
          known += cost;
        } catch {
          // A sent request never becomes free because the provider's distance cannot be priced safely.
          unknown += allocated;
          throw new GeoProviderError("GEO_PROVIDER_FAILED", "unknown");
        }
      };
      const release = await bucket.acquire(fn, geoPlan(config).rps);
      const deadline = AbortSignal.timeout(GEO_TIMEOUT_MS[fn]);
      const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
      try {
        signal.throwIfAborted();
        let response: unknown;
        try {
          response = await request(signal);
        } catch (error) {
          if (error instanceof GeoProviderError && error.charge === "none") {
            /* provably not sent */
          } else if (error instanceof GeoProviderError && error.charge === "unknown") unknown += allocated;
          else if (error instanceof GeoError && !(error instanceof GeoProviderError)) debitKnown(0);
          else if (error instanceof GeoProviderError) debitKnown(error.referenceDistanceMeters ?? 0);
          else unknown += allocated;
          if (error instanceof GeoProviderError && error.keyRejected)
            await dependencies.recordTransition("provider_key_rejected", config.timezone, context);
          throw error;
        }
        const parsed = schema.safeParse(response);
        if (!parsed.success) {
          unknown += allocated;
          throw new GeoProviderError("GEO_PROVIDER_FAILED", "unknown");
        }
        const actualDistance = pricing && distance ? distance(parsed.data) : 0;
        debitKnown(actualDistance);
        if (signal.aborted) throw new GeoError("GEO_PROVIDER_FAILED");
        // Retain valid paid results even on overrun, so an explicitly larger allowance can reuse them.
        await cache.put(key, fn, parsed.data, false);
        if (pricing && actualDistance > pricing.pairs * pricing.distanceAllowanceMeters)
          throw new GeoError("GEO_COST_OVERRUN", {
            distanceAllowanceMeters: pricing.distanceAllowanceMeters,
            actualDistanceMeters: actualDistance,
          });
        return parsed.data;
      } finally {
        await release();
      }
    });
  } catch (error) {
    failure = error;
  }
  try {
    await ledger.settle(reservation, known + unknown);
  } catch {
    // Keep the original admission debit, and make failed reconciliation visible without retaining a provider cause.
    failure = new GeoError("GEO_PROVIDER_FAILED", {
      adminHint:
        "Geo accounting settlement failed; the final ledger debit is unconfirmed. Review the original reservation and reconcile accounting reference costs in Core geo usage before retrying.",
      accounting: {
        reservationCredits: reservation.cost / 1000,
        knownReferenceCredits: known / 1000,
        unknownReferenceCredits: unknown / 1000,
      },
    });
    known = 0;
    unknown = reservation.cost;
  }
  if (failure) {
    const error = failure instanceof GeoError ? failure : new GeoError("GEO_PROVIDER_FAILED");
    throw new GeoError(error.code, { ...error.details, costs: { settledCredits: known / 1000, unknownCredits: unknown / 1000 } });
  }
  return result!;
};
