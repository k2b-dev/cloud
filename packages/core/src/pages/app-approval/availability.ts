export type ApprovalAvailability = "disabled" | "setup-required" | "configured" | "unavailable";

/** Presentation of the server-validated configuration, not a PWA health check. */
export const approvalAvailability = (config: { enabled: boolean; appOrigin: string } | null): ApprovalAvailability =>
  !config ? "unavailable" : !config.enabled ? "disabled" : !config.appOrigin ? "setup-required" : "configured";

/** Set in this browser after a FreeIPA sign-in through the app; it names no account. */
export const FREEIPA_APP_SIGN_IN_COOKIE = "login_freeipa_app";

const remembersFreeIpaApp = (cookieHeader: string | null | undefined) =>
  (cookieHeader ?? "").split(";").some((part) => part.trim() === `${FREEIPA_APP_SIGN_IN_COOKIE}=1`);

/**
 * Chooses the credential the sign-in page opens with. It receives only the
 * selected account type, the explicit `credential` link value and this
 * browser's memory, never an identifier, so the page cannot reveal whether an
 * account exists or which kind it is.
 */
export const useAppSignIn = (input: {
  configured: boolean;
  category?: string | null;
  credential?: string | null;
  cookieHeader?: string | null;
}): boolean => {
  if (!input.configured) return false;
  if (input.credential === "app") return true;
  if (input.credential === "legacy") return false;
  if (input.category === "login") return true;
  // Most FreeIPA users sign in with their password; the app stays first only where this browser used it last.
  return input.category === "freeipa" && remembersFreeIpaApp(input.cookieHeader);
};
