import type { MaintenanceState } from "@k2b/cloud/contracts/maintenance";
import {
  MAINTENANCE_BYPASS_COOKIE_NAMES,
  MAINTENANCE_BYPASS_PARAM,
  type MaintenanceBypass,
  maintenanceBypassCookieName,
  verifyMaintenanceBypassToken,
} from "@k2b/cloud/services/maintenance-bypass";

/**
 * The gateway's half of the admin bypass link (see `@k2b/cloud/services/maintenance-bypass`). It turns the link
 * into a host-only cookie and checks that cookie per request from memory. The parameter and the cookie are
 * gateway business: neither ever reaches an app.
 */

const paramName = (part: string): string | null => {
  const equals = part.indexOf("=");
  try {
    return decodeURIComponent((equals < 0 ? part : part.slice(0, equals)).replace(/\+/g, " "));
  } catch {
    return null;
  }
};

/**
 * Splits the bypass parameter off a query string (`?a=1&…`, possibly empty). `present` is true when the parameter
 * appears at all; `token` is its first value. `rest` keeps every other part byte for byte, so apps see the query
 * they would have seen without the link.
 */
export const splitBypassParam = (search: string): { present: boolean; token: string | null; rest: string } => {
  const parts = search.replace(/^\?/, "").split("&");
  let token: string | null = null;
  let present = false;
  const kept: string[] = [];
  for (const part of parts) {
    if (part !== "" && paramName(part) === MAINTENANCE_BYPASS_PARAM) {
      if (!present) {
        const equals = part.indexOf("=");
        try {
          token = equals < 0 ? "" : decodeURIComponent(part.slice(equals + 1).replace(/\+/g, " "));
        } catch {
          token = null;
        }
      }
      present = true;
    } else if (part !== "") kept.push(part);
  }
  return { present, token, rest: kept.length ? `?${kept.join("&")}` : "" };
};

/**
 * Removes every bypass cookie from `headers` and returns the values of the name this mode uses, in header order.
 * Called for every request before any routing decision, so no upstream ever receives it. `__Host-` makes that one
 * value in production; the development name can also arrive from a parent domain or another path, so a shadowing
 * cookie must not hide a valid one.
 */
export const takeBypassCookie = (headers: Headers, development: boolean): string[] => {
  const cookie = headers.get("Cookie");
  if (cookie === null) return [];
  const name = maintenanceBypassCookieName(development);
  const kept: string[] = [];
  const values: string[] = [];
  let removed = false;
  for (const part of cookie.split(";").map((value) => value.trim())) {
    const equals = part.indexOf("=");
    const key = equals < 0 ? "" : part.slice(0, equals).trim();
    if (!MAINTENANCE_BYPASS_COOKIE_NAMES.includes(key)) {
      if (part) kept.push(part);
      continue;
    }
    removed = true;
    if (key === name) values.push(part.slice(equals + 1).trim());
  }
  if (!removed) return [];
  if (kept.length) headers.set("Cookie", kept.join("; "));
  else headers.delete("Cookie");
  return values;
};

/** Whether one of the bypass cookie values is valid for the running maintenance; false when there is none. */
export const bypassesMaintenance = (tokens: readonly string[], state: MaintenanceState | null, now: number): boolean =>
  tokens.some((token) => verifyMaintenanceBypassToken(token, state, now) !== null);

/** Same path, never protocol-relative: `//evil.test` must stay on this host. */
const sameHostPath = (pathname: string): string => `/${pathname.replace(/^\/+/, "")}`;

/**
 * The answer to a request that carries the bypass parameter: always a `303` to the same address without it. A
 * valid link for the running maintenance sets the host-only cookie until the link expires and returns its
 * `bypass`, so the caller can log the redemption; anything else sets nothing. `allowCookie` is false on app
 * domains, which never bypass.
 */
export const bypassLinkAnswer = (
  url: URL,
  token: string | null,
  state: MaintenanceState | null,
  { development, allowCookie, now }: { development: boolean; allowCookie: boolean; now: number },
): { response: Response; bypass: MaintenanceBypass | null } => {
  const { rest } = splitBypassParam(url.search);
  const headers = new Headers({
    Location: `${sameHostPath(url.pathname)}${rest}`,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  const bypass = allowCookie ? verifyMaintenanceBypassToken(token, state, now) : null;
  if (bypass && token) {
    const maxAge = Math.max(1, Math.floor((bypass.expiresAt - now) / 1000));
    // Literal names, so the credential-cookie guard can read them; a test pins them to maintenanceBypassCookieName().
    const bypassCookie = development ? "cloud_maintenance_bypass" : "__Host-cloud_maintenance_bypass";
    headers.set(
      "Set-Cookie",
      `${bypassCookie}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly;${development ? "" : " Secure;"} SameSite=Lax`,
    );
  }
  return { response: new Response(null, { status: 303, headers }), bypass: bypass && token ? bypass : null };
};
