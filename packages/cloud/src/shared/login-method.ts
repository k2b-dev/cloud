export type LoginMethodPreference = "email" | "ipa" | "passkey" | "guest" | "login";
export type LoginFallbackMethod = "email" | "ipa";

const LOGIN_METHOD_COOKIE = "login_method";

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
