export type LoginMethodPreference = "email" | "ipa" | "passkey" | "guest" | "login";
export type LoginFallbackMethod = "email" | "ipa";

const LOGIN_METHOD_COOKIE = "login_method";

/** Set in a browser after a FreeIPA sign-in through the app; it names no account. */
export const FREEIPA_APP_SIGN_IN_COOKIE = "login_freeipa_app";

/** Set in a browser after a sign-in by email code for the login account category; it names no account. */
export const LOGIN_EMAIL_SIGN_IN_COOKIE = "login_email";

/** Everything the sign-in page remembers in a browser. A shared workstation keeps none of it. */
export const LOGIN_MEMORY_COOKIES = [LOGIN_METHOD_COOKIE, FREEIPA_APP_SIGN_IN_COOKIE, LOGIN_EMAIL_SIGN_IN_COOKIE] as const;

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isLoginMethodPreference = (value: string): value is LoginMethodPreference =>
  value === "email" || value === "ipa" || value === "passkey" || value === "guest" || value === "login";

export const readLoginMethodFromCookieHeader = (cookieHeader: string | null | undefined): LoginMethodPreference | null => {
  let resolved: LoginMethodPreference | null = null;
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    if (trimmed.slice(0, separatorIndex) !== LOGIN_METHOD_COOKIE) continue;

    const value = decodeCookieValue(trimmed.slice(separatorIndex + 1));
    if (isLoginMethodPreference(value)) resolved = value;
  }
  return resolved;
};

export const resolveLoginFallbackMethod = (params: {
  freeIpaEnabled: boolean;
  hasToken: boolean;
  isGuestHidden: boolean;
  queryMethod: string | undefined;
  persistedMethod: LoginMethodPreference | null;
}): LoginFallbackMethod => {
  if (!params.freeIpaEnabled) return "email";
  if (params.hasToken) return "email";
  if (params.isGuestHidden) return "ipa";
  if (params.queryMethod === "ipa" || params.queryMethod === "email") return params.queryMethod;
  if (params.persistedMethod === "ipa") return "ipa";
  return "email";
};
