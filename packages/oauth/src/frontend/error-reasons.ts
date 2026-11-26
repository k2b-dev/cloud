import type { OAuthClient } from "../contracts";
import { canUseDeviceGrant } from "../service/clients";

/**
 * Every reason this app sends a person to its error page. The page shows only these codes, each with its own sentence,
 * never text from the address; anything else is `unknown_error`.
 */
export const ERROR_REASONS = [
  "consent_missing",
  "consent_invalid",
  "consent_expired",
  "client_unavailable",
  "origin_invalid",
  "account_not_allowed",
  "web_session_required",
  "device_session_required",
  "sign_in_again",
] as const;

export type ErrorReason = (typeof ERROR_REASONS)[number];

export const isErrorReason = (code: string): code is ErrorReason => (ERROR_REASONS as readonly string[]).includes(code);

/**
 * Whether a page may name this application: not one that registered itself (anyone can register any name), and one an
 * administrator set up for device sign-in, the only flow that names it.
 */
export const mayBeNamed = (client: OAuthClient): boolean => client.registrationKind !== "dynamic" && canUseDeviceGrant(client);

/** The address of the error page for one reason; `client` names the application by its registered client ID. */
export const errorPageHref = (reason: ErrorReason, client?: string) =>
  `/oauth/error?${new URLSearchParams({ error: reason, ...(client ? { client } : {}) })}`;
