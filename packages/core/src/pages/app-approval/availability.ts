export type ApprovalAvailability = "disabled" | "setup-required" | "configured" | "unavailable";

/** Presentation of the server-validated configuration, not a PWA health check. */
export const approvalAvailability = (config: { enabled: boolean; appOrigin: string } | null): ApprovalAvailability =>
  !config ? "unavailable" : !config.enabled ? "disabled" : !config.appOrigin ? "setup-required" : "configured";

export const useAppSignIn = (configured: boolean, credential: string | null) => configured && credential === "app";
