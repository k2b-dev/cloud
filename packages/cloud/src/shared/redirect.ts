const REDIRECT_BASE = "https://cloud.local";

/** Normalize a user-provided post-login redirect to a local Cloud path. */
export const normalizeRedirectTo = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return undefined;

  try {
    const url = new URL(trimmed, REDIRECT_BASE);
    // Dot segments can resolve to `//host`, which a browser reads as another host.
    if (url.origin !== REDIRECT_BASE || url.pathname.startsWith("//")) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
};

/** Extract a safe post-login redirect target from an incoming request URL. */
export const redirectPathFromRequestUrl = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  return normalizeRedirectTo(`${url.pathname}${url.search}`) ?? "/";
};

/** Build the local login URL for an incoming protected request. */
export const createLoginRedirectUrl = (requestUrl: string): string => {
  const params = new URLSearchParams();
  params.set("redirectTo", redirectPathFromRequestUrl(requestUrl));
  return `/auth/login?${params.toString()}`;
};

/** Build an absolute auth login URL while preserving only safe local redirects. */
export const createAuthLoginUrl = (
  appUrl: string,
  params: { token?: string; method?: "email" | "ipa" | "admin"; redirectTo?: string | null | undefined } = {},
): string => {
  const url = new URL(`${appUrl.replace(/\/$/, "")}/auth/login`);
  if (params.token) url.searchParams.set("token", params.token);
  if (params.method) url.searchParams.set("method", params.method);

  const redirectTo = normalizeRedirectTo(params.redirectTo);
  if (redirectTo) url.searchParams.set("redirectTo", redirectTo);

  return url.toString();
};

/** Build an absolute password-reset URL while preserving only safe local redirects. */
export const createAuthPasswordResetUrl = (appUrl: string, params: { token: string; redirectTo?: string | null | undefined }): string => {
  const url = new URL(`${appUrl.replace(/\/$/, "")}/auth/password-reset`);
  url.searchParams.set("token", params.token);

  const redirectTo = normalizeRedirectTo(params.redirectTo);
  if (redirectTo) url.searchParams.set("redirectTo", redirectTo);

  return url.toString();
};
