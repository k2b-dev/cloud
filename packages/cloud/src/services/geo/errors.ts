import type { CapabilityErrorStatus } from "../../contracts/capabilities";
import type { GeoErrorCode } from "../../contracts/geo";

export class GeoError extends Error {
  constructor(
    readonly code: GeoErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code); // Never retain a provider body, request, credential, or transport cause.
    this.name = "GeoError";
    if (code === "GEO_PROVIDER_FAILED") this.details = { costs: { settledCredits: 0, unknownCredits: 0 }, ...details };
  }
  get status(): CapabilityErrorStatus {
    if (this.code === "GEO_FORBIDDEN") return 403;
    if (this.code === "GEO_BUSY") return 429;
    if (this.code === "GEO_PROVIDER_FAILED") return 502;
    if (this.code === "GEO_NOT_CONFIGURED") return 503;
    if (this.code === "GEO_BUDGET_EXHAUSTED") return 429;
    if (this.code === "GEO_ADDRESS_NOT_FOUND") return 404;
    if (this.code === "GEO_ADDRESS_AMBIGUOUS") return 409;
    return 400;
  }
}
export const limitExceeded = (limit: string, max: number, actual: number): never => {
  throw new GeoError("GEO_LIMIT_EXCEEDED", { limit, max, actual });
};
export const busy = (retryAfterSeconds = 1) => new GeoError("GEO_BUSY", { retryAfterSeconds });
