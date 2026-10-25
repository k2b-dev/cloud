import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { GeoError } from "@k2b/cloud/services/geo/errors";
import { geoCapabilityMessages } from "./geo-capability-messages";

export const runGeoQuery = async <T>(context: CapabilityExecutionContext, call: () => Promise<T>) => {
  try {
    return { ok: true as const, data: { data: await call() } };
  } catch (cause) {
    const error =
      cause instanceof GeoError ? cause : new GeoError("GEO_PROVIDER_FAILED", { costs: { settledCredits: 0, unknownCredits: 0 } });
    const messages = geoCapabilityMessages(context.locale);
    const { requiredCredits, availableCredits, shortfallCredits, actual, max } = error.details;
    const required = error.code === "GEO_LIMIT_EXCEEDED" && error.details.limit === "reservationCredits" ? actual : requiredCredits;
    const available = error.code === "GEO_LIMIT_EXCEEDED" && error.details.limit === "reservationCredits" ? max : availableCredits;
    const numbers =
      typeof required === "number" && typeof available === "number"
        ? " " +
          messages.budgetNumbers({
            required: new Intl.NumberFormat(context.locale).format(required),
            available: new Intl.NumberFormat(context.locale).format(available),
            missing: new Intl.NumberFormat(context.locale).format(
              typeof shortfallCredits === "number" ? shortfallCredits : required - available,
            ),
          })
        : "";
    return {
      ok: false as const,
      error: { code: error.code, message: messages[error.code] + numbers, status: error.status, details: error.details },
    };
  }
};
