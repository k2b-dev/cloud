import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { GeoError } from "@k2b/cloud/services/geo/errors";
import { geoCapabilityMessages } from "./geo-capability-messages";

export const runGeoQuery = async <T>(context: CapabilityExecutionContext, call: () => Promise<T>) => {
  try {
    return { ok: true as const, data: { data: await call() } };
  } catch (cause) {
    const error =
      cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED", { costs: { settledCredits: 0, unknownCredits: 0 } });
    return {
      ok: false as const,
      error: { code: error.code, message: geoCapabilityMessages(context.locale)[error.code], status: error.status, details: error.details },
    };
  }
};
