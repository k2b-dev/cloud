import { safeErrorDetail } from "./error-messages";

export const providerErrorCode = (error: unknown, fallback: string): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
};

export const providerErrorMessage = (error: unknown, fallback: string): string =>
  (error instanceof Error ? error.message : fallback).slice(0, 1_000);

// RFC 5530 codes with which an IMAP server refuses a login for now, not the credentials: the
// service is temporarily unavailable, the account is in use elsewhere, or a connection limit is
// reached. ImapFlow marks every refused login as an authentication failure.
const TEMPORARY_LOGIN_REFUSAL_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT"]);

export const isTemporaryLoginRefusal = (error: unknown): boolean => {
  const value = error as { authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  return (
    value?.authenticationFailed === true &&
    typeof value.serverResponseCode === "string" &&
    TEMPORARY_LOGIN_REFUSAL_CODES.has(value.serverResponseCode.toUpperCase())
  );
};

/** The provider's original failures behind a failed IMAP and SMTP verification, see imapSmtpConnector.verify. */
const verificationFailures = (error: unknown): unknown[] => {
  const value = error as { code?: unknown; failures?: unknown } | null;
  return value?.code === "PROVIDER_TRANSPORT_VERIFICATION_FAILED" && Array.isArray(value.failures) ? value.failures : [];
};

/** The provider rejected the credentials, so the account must be reconnected. A login refused only for now is not. */
export const isProviderAuthenticationFailure = (error: unknown, code = providerErrorCode(error, "")): boolean => {
  if (isTemporaryLoginRefusal(error)) return false;
  const value = error as { authenticationFailed?: unknown } | null;
  return (
    value?.authenticationFailed === true ||
    code === "EAUTH" ||
    code.includes("AUTHENTICATION") ||
    code.includes("AUTH_FAILED") ||
    verificationFailures(error).some((failure) => isProviderAuthenticationFailure(failure))
  );
};

/**
 * Returns the provider's own explanation of a failure, redacted and bounded for display.
 * IMAP servers put it in the tagged response text; SMTP and TLS errors carry it in the message.
 */
export const providerErrorDetail = (error: unknown, secrets: readonly string[] = []): string | null => {
  const value = error as { message?: unknown; responseText?: unknown; serverResponseCode?: unknown } | null;
  const responseText = typeof value?.responseText === "string" ? value.responseText : "";
  const responseCode = typeof value?.serverResponseCode === "string" ? value.serverResponseCode : "";
  const text = responseText ? `${responseCode} ${responseText}` : typeof value?.message === "string" ? value.message : "";
  return safeErrorDetail(text, secrets);
};

/**
 * Codes of a provider connection that failed: either it never got far enough for the provider
 * to receive a command, or it broke while a command waited for its reply. Callers that care
 * whether a provider effect may have happened track that themselves.
 */
const TRANSIENT_PROVIDER_CODES = new Set([
  // The provider could not be reached.
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  // Nodemailer's code for a failed DNS lookup.
  "EDNS",
  "ENDPOINT_DNS_TIMEOUT",
  // ImapFlow's codes for a server that does not complete the connection or the TLS upgrade.
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  // The connection broke mid-command.
  "ETIMEDOUT",
  // ImapFlow's code for a socket timeout while a command waits for its reply.
  "ETIMEOUT",
  // ImapFlow fails every command of a connection that closed underneath it, such as after a
  // socket timeout or a reset, with one of these codes.
  "NoConnection",
  "EConnectionClosed",
  "StateLogout",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ESOCKET",
  "ECONNECTION",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "IMAP_CONNECTION_CLOSED",
]);

/**
 * The provider could not be reached, the connection broke, or the server refused the login for
 * now. Nothing about the request or the credentials failed, so the same work can succeed once
 * the provider recovers.
 */
export const isTransientProviderFailure = (error: unknown): boolean => {
  // The raw code, because providerErrorCode drops ImapFlow's mixed-case codes such as NoConnection.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_PROVIDER_CODES.has(code)) return true;
  // A failed verification counts when IMAP, SMTP, or both failed only transiently.
  const failures = verificationFailures(error);
  return isTemporaryLoginRefusal(error) || (failures.length > 0 && failures.every(isTransientProviderFailure));
};
