import { createHmac, timingSafeEqual } from "node:crypto";
import type { MaintenanceState } from "../contracts/maintenance";

/**
 * Admin bypass for whole-Cloud maintenance. Core checks the administrator role and signs a token with the
 * maintenance's own `bypassKey`; the gateway verifies it from memory. The token passes only the maintenance wall
 * on the Cloud host: the person still signs in as usual, and the token dies with the maintenance it names.
 *
 * Token: `base64url(JSON {v:1, m, s, exp})` + "." + `base64url(HMAC-SHA256(bypassKey, first part))`.
 */

/** Query parameter of the link; the gateway answers it itself and never passes it to an app. */
export const MAINTENANCE_BYPASS_PARAM = "cloud-maintenance-bypass";

/** A link lasts at most this long; for a longer maintenance the administrator asks again. */
export const MAINTENANCE_BYPASS_TTL_MS = 12 * 60 * 60 * 1000;

/** Real tokens are about 200 characters; anything much longer is not one and is never parsed. */
export const MAINTENANCE_BYPASS_MAX_TOKEN_LENGTH = 512;

/** Host-only cookie, `__Host-` and `Secure` outside development, like Core's own cookies. */
export const maintenanceBypassCookieName = (development: boolean): string =>
  development ? "cloud_maintenance_bypass" : "__Host-cloud_maintenance_bypass";

export const MAINTENANCE_BYPASS_COOKIE_NAMES: readonly string[] = [maintenanceBypassCookieName(true), maintenanceBypassCookieName(false)];

type BypassScope = Pick<MaintenanceState, "id" | "bypassKey">;

export type MaintenanceBypass = { subject: string; expiresAt: number };

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const SUBJECT_MAX_LENGTH = 200;
/** Clock skew between Core and the gateway that an expiry may exceed the maximum lifetime by. */
const SKEW_SECONDS = 60;

const sign = (key: string, payload: string): Buffer => createHmac("sha256", Buffer.from(key, "base64url")).update(payload).digest();

/** A token for `subject` (a user id) that passes this maintenance until `expiresAt` (epoch ms). */
export const issueMaintenanceBypassToken = (scope: BypassScope, subject: string, expiresAt: number): string => {
  const payload = Buffer.from(JSON.stringify({ v: 1, m: scope.id, s: subject, exp: Math.floor(expiresAt / 1000) })).toString("base64url");
  return `${payload}.${sign(scope.bypassKey, payload).toString("base64url")}`;
};

/**
 * The token's subject and expiry when it is signed with this maintenance's key, names this maintenance and has not
 * expired; `null` for anything else. The signature is checked before the payload is parsed. Never throws.
 */
export const verifyMaintenanceBypassToken = (
  token: unknown,
  scope: BypassScope | null,
  now: number = Date.now(),
): MaintenanceBypass | null => {
  if (!scope || typeof token !== "string" || token.length > MAINTENANCE_BYPASS_MAX_TOKEN_LENGTH || !TOKEN.test(token)) return null;
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = sign(scope.bypassKey, payload);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const { v, m, s, exp, ...rest } = claims as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || v !== 1 || m !== scope.id) return null;
  if (typeof s !== "string" || s.length === 0 || s.length > SUBJECT_MAX_LENGTH) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (exp <= nowSeconds || exp > nowSeconds + MAINTENANCE_BYPASS_TTL_MS / 1000 + SKEW_SECONDS) return null;
  return { subject: s, expiresAt: exp * 1000 };
};
