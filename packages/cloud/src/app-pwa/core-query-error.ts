import type { GeoError } from "../services/geo/errors";

/** Guest-safe errors from the allowlisted platform adapter, never from application handlers. */
export class AppPwaCoreQueryError extends Error {
  readonly code: GeoError["code"];
  readonly status: GeoError["status"];
  readonly details?: { scope: "person" | "cloud"; resetsAt: string };
  constructor(error: GeoError) {
    super(error.code);
    this.code = error.code;
    this.status = error.status;
    if (
      error.code === "GEO_BUDGET_EXHAUSTED" &&
      (error.details.scope === "person" || error.details.scope === "cloud") &&
      typeof error.details.resetsAt === "string"
    ) {
      this.details = { scope: error.details.scope, resetsAt: error.details.resetsAt };
    }
  }
}
