import { normalizeRedirectTo } from "@k2b/cloud/shared";

/** Every browser sign-in finishes through the same first-use consent screen. */
export const afterSignInHref = (redirectTo?: string) =>
  `/auth/continue?${new URLSearchParams({ redirectTo: normalizeRedirectTo(redirectTo) ?? "/" })}`;

/** Display credential entry without revoking the existing session. This never refreshes authentication itself. */
export const isReauthenticationRequest = (requestUrl: string): boolean => {
  const request = new URL(requestUrl);
  const target = normalizeRedirectTo(request.searchParams.get("redirectTo"));
  return !!target && new URL(target, request.origin).searchParams.get("reauthenticate") === "1";
};

/** Resolve where an already-authenticated visitor should leave the login page. */
export const resolveAuthenticatedLoginRedirect = (requestUrl: string): string => {
  const request = new URL(requestUrl);

  // A signed-in session must not implicitly consume or bypass a magic-link token.
  if (request.searchParams.has("token")) return "/";

  const redirectTo = normalizeRedirectTo(request.searchParams.get("redirectTo"));
  if (!redirectTo) return "/";

  // Avoid redirecting the login guard back into itself.
  if (new URL(redirectTo, request.origin).pathname === "/auth/login") return "/";

  return redirectTo;
};
