import type { z } from "zod";
import type { GeoFunction } from "../../contracts/geo";
import type { createGeoBucket } from "./bucket";
import { GEO_TIMEOUT_MS } from "./bucket";
import type { createGeoCache } from "./cache";
import { geoCacheKey } from "./cache";
import { geoReferenceCost } from "./costs";
import { GeoError, GeoProviderError, limitExceeded } from "./errors";
import type { createGeoLedger } from "./ledger";
import { geoRouteReferenceCost } from "./route-costs";
import type { GeoContext } from "./service";
import { type GeoConfig, geoPlan } from "./settings";

export type GeoRouteChainDependencies = {
  cache: ReturnType<typeof createGeoCache>;
  bucket: ReturnType<typeof createGeoBucket>;
  ledger: ReturnType<typeof createGeoLedger>;
  now: () => Date;
  recordTransition: (
    event: "monthly_budget_exhausted" | "provider_key_rejected" | "route_cost_overrun",
    timezone: string,
    context: GeoContext,
    metadata?: Record<string, number>,
  ) => Promise<boolean | void>;
};
export type GeoRouteCallPricing = { pairs: number; avoids: number; optimize: boolean; estimatedDistanceMeters: number };
export const reserveRouteCall = (pricing: GeoRouteCallPricing) =>
  geoRouteReferenceCost({ ...pricing, distanceMeters: pricing.estimatedDistanceMeters });
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
    reservation = await ledger.reserve(context.accessSubject, config, reserveCost, "route", now());
  } catch (error) {
    if (error instanceof GeoError && error.code === "GEO_BUDGET_EXHAUSTED" && error.details.scope === "cloud")
      await dependencies.recordTransition("monthly_budget_exhausted", config.timezone, context);
    throw error;
  }
  let known = 0,
    unknown = 0;
  let result: T | undefined, failure: unknown;
  let overrun:
    | { estimatedDistanceMeters: number; actualDistanceMeters: number; reservedCredits: number; actualCredits: number }
    | undefined;
  try {
    result = await work(async (fn, input, schema, request, pricing, distance) => {
      context.signal?.throwIfAborted();
      const key = geoCacheKey(fn, input, context.locale ?? "en");
      const hit = await cache.get(key, schema);
      if (hit !== null) return hit; // Cached provider results incur no new cost.
      const allocated = pricing ? reserveRouteCall(pricing) : geoReferenceCost({ fn });
      const debitKnown = (meters: number) => {
        try {
          const cost = pricing ? geoRouteReferenceCost({ ...pricing, distanceMeters: meters }) : allocated;
          if (!Number.isSafeInteger(known + unknown + cost)) throw new Error("Unrepresentable reference cost");
          known += cost;
          if (pricing && cost > allocated)
            overrun = {
              estimatedDistanceMeters: pricing.estimatedDistanceMeters,
              actualDistanceMeters: meters,
              reservedCredits: allocated / 1000,
              actualCredits: cost / 1000,
            };
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
        // Retain paid results even on overrun so an explicit retry can reuse them without paying again.
        await cache.put(key, fn, parsed.data, false);
        if (overrun) throw new GeoError("GEO_COST_OVERRUN", overrun);
        return parsed.data;
      } finally {
        await release();
      }
    });
  } catch (error) {
    failure = error;
  }
  if (overrun) failure = new GeoError("GEO_COST_OVERRUN", overrun);
  const knownReferenceCredits = known / 1000;
  let settlementConfirmed = true;
  try {
    await ledger.settle(reservation, known + unknown);
  } catch {
    settlementConfirmed = false;
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
    if (overrun) {
      const recorded = await dependencies.recordTransition("route_cost_overrun", config.timezone, context, {
        reservedCredits: reservation.cost / 1000,
        settledCredits: known / 1000,
        unknownCredits: unknown / 1000,
        knownReferenceCredits,
        settlementConfirmed: settlementConfirmed ? 1 : 0,
        estimatedCallCredits: overrun.reservedCredits,
        actualCallCredits: overrun.actualCredits,
      });
      if (recorded === false)
        error.details.adminHint =
          "The routing cost overrun could not be recorded in the audit log. Reconcile the reported costs before retrying. " +
          (typeof error.details.adminHint === "string" ? error.details.adminHint : "");
    }
    throw new GeoError(error.code, { ...error.details, costs: { settledCredits: known / 1000, unknownCredits: unknown / 1000 } });
  }
  return result!;
};
