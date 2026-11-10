import type { SQLQuery } from "bun";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../../config/env";
import { sql } from "../../runtime/clients";
import { readCookie } from "../../server/request-cookies";
import { LOGIN_MEMORY_COOKIES } from "../../shared/login-method";
import * as settings from "../settings";

/**
 * A browser marked as a shared workstation, such as a PC at a counter. The mark belongs to the browser, not to a
 * person: it outlives sign-out. It only decides how new sign-ins start there; the idle limit itself is held by the
 * server on each session family (`last_input_at`), so removing or copying the cookie changes no running session.
 */
const cookieName = (development: boolean) => (development ? "cloud_shared_workstation" : "__Host-cloud_shared_workstation");
export const sharedWorkstationCookieName = (development = env.IS_DEVELOPMENT): string => cookieName(development);

/** Browsers keep a cookie at most 400 days; every sign-in on the marked browser renews it. */
const MARK_MAX_AGE_SECONDS = 400 * 86_400;

export const SHARED_WORKSTATION_IDLE_SETTING = "user.session.shared_workstation_idle_minutes";

/** Whether the request comes from a browser marked as a shared workstation. */
export const readSharedWorkstationMark = (headers: Headers, development = env.IS_DEVELOPMENT): boolean =>
  readCookie(headers, cookieName(development)) === "1";

export const isSharedWorkstation = (c: Context, development = env.IS_DEVELOPMENT): boolean =>
  readSharedWorkstationMark(c.req.raw.headers, development);

export const setSharedWorkstationCookie = (c: Context, shared: boolean, development = env.IS_DEVELOPMENT): void => {
  if (!shared) {
    deleteCookie(c, cookieName(development), { path: "/", secure: !development });
    return;
  }
  // Lax, not Strict: a sign-in page opened from a link in another site must still know it stands on a shared workstation.
  setCookie(c, cookieName(development), "1", {
    httpOnly: true,
    secure: !development,
    sameSite: "Lax",
    path: "/",
    maxAge: MARK_MAX_AGE_SECONDS,
  });
};

/** Removes what the sign-in page remembers in this browser: the last sign-in method and the credential it chose. */
export const forgetSignInMemory = (c: Context): void => {
  for (const name of LOGIN_MEMORY_COOKIES) if (getCookie(c, name) !== undefined) deleteCookie(c, name, { path: "/" });
};

/** The administrator's idle limit in seconds. */
export const sharedWorkstationIdleSeconds = async (): Promise<number> => {
  const minutes = await settings.get<number>(SHARED_WORKSTATION_IDLE_SETTING);
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error(`${SHARED_WORKSTATION_IDLE_SETTING} must be a positive number`);
  return Math.floor(minutes * 60);
};

/**
 * SQL condition: a family's idle limit has not passed. Request authentication ends such a family when it sees it;
 * every check that reads `auth.session_families` directly adds this, so a family nobody used since is not valid
 * either. `lastInputAt` is the column, such as sql`f.last_input_at`; read `timeoutSeconds` with
 * `sharedWorkstationIdleSeconds()`. Synchronous on purpose: a query fragment is thenable, so awaiting or returning it
 * from an async function would run it on its own.
 */
export const withinIdleLimit = (lastInputAt: SQLQuery, timeoutSeconds: number): SQLQuery =>
  sql`(${lastInputAt} IS NULL OR ${lastInputAt} > now() - ${timeoutSeconds} * interval '1 second')`;
