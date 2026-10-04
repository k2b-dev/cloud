import { safeErrorDetail } from "./error-messages";

export const providerErrorCode = (error: unknown, fallback: string): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
};

export const providerErrorMessage = (error: unknown, fallback: string): string =>
  (error instanceof Error ? error.message : fallback).slice(0, 1_000);

// RFC 5530 codes with which an IMAP server refuses a login for now, not the credentials: the
// service is temporarily unavailable, the account is in use elsewhere, or a connection limit is
// reached.
const TEMPORARY_LOGIN_REFUSAL_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT"]);

// Gmail refuses a login over its connection limit with [ALERT] instead of [LIMIT]. Gmail also uses
// [ALERT] for logins that need the user, such as an app password, so only this text counts.
const isConnectionLimitAlert = (value: { serverResponseCode?: unknown; responseText?: unknown }): boolean =>
  typeof value.serverResponseCode === "string" &&
  value.serverResponseCode.toUpperCase() === "ALERT" &&
  typeof value.responseText === "string" &&
  /too many simultaneous connections/i.test(value.responseText);

/**
 * A login that failed for now, not because of the credentials. ImapFlow marks every failed LOGIN
 * or AUTHENTICATE as an authentication failure, also one whose connection broke before the reply
 * and one the server refused with a temporary RFC 5530 code or at Gmail's connection limit. An
 * SMTP server answers a login it cannot check for now with a 4xx reply, such as 454 (RFC 4954).
 */
export const isTemporaryLoginFailure = (error: unknown): boolean => {
  const value = error as {
    code?: unknown;
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    responseText?: unknown;
    responseCode?: unknown;
  } | null;
  if (value?.authenticationFailed === true) {
    return (
      (typeof value.serverResponseCode === "string" && TEMPORARY_LOGIN_REFUSAL_CODES.has(value.serverResponseCode.toUpperCase())) ||
      isConnectionLimitAlert(value) ||
      (typeof value.code === "string" && TRANSIENT_PROVIDER_CODES.has(value.code))
    );
  }
  const responseCode = Number(value?.responseCode);
  return value?.code === "EAUTH" && responseCode >= 400 && responseCode < 500;
};

/** The provider's original failures behind a failed IMAP and SMTP verification, see imapSmtpConnector.verify. */
const verificationFailures = (error: unknown): unknown[] => {
  const value = error as { code?: unknown; failures?: unknown } | null;
  return value?.code === "PROVIDER_TRANSPORT_VERIFICATION_FAILED" && Array.isArray(value.failures) ? value.failures : [];
};

/** The provider rejected the credentials, so the account must be reconnected. A login that failed only for now is not. */
export const isProviderAuthenticationFailure = (error: unknown, code = providerErrorCode(error, "")): boolean => {
  if (isTemporaryLoginFailure(error)) return false;
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
 * The provider could not be reached, the connection broke, or the login failed for now. Nothing
 * about the request or the credentials failed, so the same work can succeed once the provider
 * recovers.
 */
export const isTransientProviderFailure = (error: unknown): boolean => {
  // The raw code, because providerErrorCode drops ImapFlow's mixed-case codes such as NoConnection.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_PROVIDER_CODES.has(code)) return true;
  // RFC 5321: 421 closes the channel because the service is not available, such as an SMTP server
  // at its connection limit. Nodemailer reports one in the greeting as EPROTOCOL.
  if (Number((error as { responseCode?: unknown } | null)?.responseCode) === 421) return true;
  // A failed verification counts when IMAP, SMTP, or both failed only transiently.
  const failures = verificationFailures(error);
  return isTemporaryLoginFailure(error) || (failures.length > 0 && failures.every(isTransientProviderFailure));
};

// Codes of a provider that did not answer in time, so the attempt waited for a timeout before it
// failed: a host that drops connection attempts, a server that sends no greeting or does not
// finish the TLS upgrade, or a connection whose replies stop.
const PROVIDER_TIMEOUT_CODES = new Set([
  "ENDPOINT_DNS_TIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEDOUT",
  "ETIMEOUT",
]);

/**
 * The provider's mailbox server did not answer before a timeout. Unlike a refused or dropped
 * connection, each such attempt holds its job for the whole timeout. Counts the cause of an error,
 * such as the socket timeout behind ImapFlow's NoConnection for a command whose reply never came,
 * and the IMAP failure of a failed IMAP and SMTP verification, but not its SMTP failure.
 */
export const isProviderTimeout = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; cause?: unknown; imapFailure?: unknown };
    if (typeof value.code === "string" && PROVIDER_TIMEOUT_CODES.has(value.code)) return true;
    current = value.code === "PROVIDER_TRANSPORT_VERIFICATION_FAILED" ? value.imapFailure : value.cause;
  }
  return false;
};
