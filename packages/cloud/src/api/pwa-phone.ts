import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../config/env";
import { PWA_AUTH_PATH, PWA_COOKIES, PWA_LIMITS, PWA_SCOPE, PwaClaimSchema, type PwaLaunchState, PwaRenameSchema } from "../contracts/pwa";
import { type AuthContext, auth, rateLimit, v } from "../server";
import { type PwaCredentials, PwaError, pwaDevices } from "../services/pwa-devices";
import { defaultShellAvailable, handlePwaError, type PwaRouteOptions, pwaErrorResponse, pwaInvalidRequest, pwaTransport } from "./pwa";

const PAIRING_COOKIE_PATH = `${PWA_AUTH_PATH}/pairings`;
const cookie = { httpOnly: true, secure: !env.IS_DEVELOPMENT } as const;

const setAppCredentials = (c: Context, credentials: PwaCredentials) => {
  setCookie(c, PWA_COOKIES.session, credentials.sessionToken, { ...cookie, sameSite: "Lax", path: "/", maxAge: PWA_LIMITS.sessionSeconds });
  // Only Core's /pwa/_auth endpoints ever receive the device key.
  setCookie(c, PWA_COOKIES.device, credentials.deviceKey, {
    ...cookie,
    sameSite: "Lax",
    path: PWA_AUTH_PATH,
    maxAge: PWA_LIMITS.idleDays * 86_400,
  });
};
const clearAppCredentials = (c: Context) => {
  deleteCookie(c, PWA_COOKIES.session, { ...cookie, path: "/" });
  deleteCookie(c, PWA_COOKIES.device, { ...cookie, path: PWA_AUTH_PATH });
};
const clearPairing = (c: Context) => deleteCookie(c, PWA_COOKIES.pairing, { ...cookie, path: PAIRING_COOKIE_PATH });

const authenticated = async (c: Context, token: string | null) => (token ? auth.session.authenticateRequest(c, token) : null);
const appSession = async (c: Context) => {
  const session = await authenticated(c, auth.session.getAppToken(c));
  return session?.data.kind === "app" ? session : null;
};
const webSession = async (c: Context) => {
  const session = await authenticated(c, auth.session.getWebToken(c));
  return session?.data.kind === "web" ? session : null;
};

/**
 * A path inside the app to return to after the launch bounce; anything else becomes `/pwa/`.
 * The `pwa_launch` marker lets the page stop instead of bouncing again.
 */
export const launchTarget = (to: string | undefined): string => {
  const fallback = `${PWA_SCOPE}?pwa_launch=1`;
  if (!to || to.length > 2048 || !to.startsWith(PWA_SCOPE) || to.includes("//") || to.includes("\\")) return fallback;
  const url = new URL(to, "http://launch.invalid");
  // Judge the path the browser will request: dot segments and escapes are resolved by then.
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return fallback;
  }
  const inside = (value: string) => value.startsWith(PWA_SCOPE) && value !== PWA_AUTH_PATH && !value.startsWith(`${PWA_AUTH_PATH}/`);
  if (url.origin !== "http://launch.invalid" || !inside(url.pathname) || !inside(path) || path.includes("//")) return fallback;
  url.searchParams.set("pwa_launch", "1");
  return url.pathname + url.search;
};

const stateUrl = (state: PwaLaunchState) => `${PWA_SCOPE}?pwa=${state}`;

/**
 * Phone side of the mobile app (preview), mounted by Core at `/pwa/_auth` before its page
 * catch-all. The device key and the completion secret use cookie paths below `/pwa/_auth`,
 * which only Core serves; other applications see only the 24-hour app session.
 */
export const createPwaPhoneRoutes = (options: PwaRouteOptions = {}) => {
  const service = options.service ?? pwaDevices;
  const shellAvailable = options.shellAvailable ?? defaultShellAvailable;
  const limit = rateLimit({ keyBy: "ip" });
  const requireShell = (c: Context) => {
    if (!shellAvailable(c)) throw new PwaError("UNAVAILABLE", 503);
  };
  return new Hono<AuthContext>()
    .onError(handlePwaError)
    .use("*", ...pwaTransport())
    .use("*", async (c, next) => {
      const limited = await limit(c, next);
      // A navigation always gets a page, never JSON: a limited launch shows the unavailable state, which retries.
      if (limited instanceof Response && c.req.method === "GET" && c.req.path.endsWith("/session/launch")) {
        return c.redirect(stateUrl("unavailable"), 302);
      }
      return limited;
    })
    .post("/pairings/claim", v("json", PwaClaimSchema, pwaInvalidRequest), async (c) => {
      requireShell(c);
      const input = c.req.valid("json");
      const claimed = await service.claimPairing({ ...input, userAgent: c.req.header("User-Agent") });
      setCookie(c, PWA_COOKIES.pairing, claimed.completionSecret, {
        ...cookie,
        sameSite: "Strict",
        path: PAIRING_COOKIE_PATH,
        maxAge: Math.max(1, Math.ceil((Date.parse(claimed.expiresAt) - Date.now()) / 1000)),
      });
      return c.json({ code: claimed.code, account: claimed.account, expiresAt: claimed.expiresAt });
    })
    .post("/pairings/complete", async (c) => {
      requireShell(c);
      const web = await webSession(c);
      try {
        const result = await service.completePairing(c, {
          completionSecret: getCookie(c, PWA_COOKIES.pairing),
          deviceKey: getCookie(c, PWA_COOKIES.device),
          appSession: await appSession(c),
          webUserId: web?.user.id ?? null,
        });
        if (result.state === "waiting") return c.json(result, 202);
        if (result.credentials) setAppCredentials(c, result.credentials);
        clearPairing(c);
        // A Home Screen app on iOS has its own cookie jar; a web session there is only a copy from Safari.
        if (result.platform === "ios" && auth.session.getWebToken(c)) deleteCookie(c, "session_token", { path: "/" });
        return c.json({ state: "paired" as const });
      } catch (error) {
        if (error instanceof PwaError && error.code === "EXPIRED") clearPairing(c);
        throw error;
      }
    })
    .get("/session/launch", async (c) => {
      const to = launchTarget(c.req.query("to"));
      if (!shellAvailable(c)) return c.redirect(stateUrl("unavailable"), 302);
      try {
        const result = await service.renew(c, { deviceKey: getCookie(c, PWA_COOKIES.device), appSession: await appSession(c) });
        if (result.outcome === "renewed") setAppCredentials(c, result.credentials);
        if (result.outcome === "renewed" || result.outcome === "current") return c.redirect(to, 302);
        if (result.outcome === "blocked") return c.redirect(stateUrl("blocked"), 302);
        if (result.outcome === "ended") clearAppCredentials(c);
        return c.redirect(stateUrl(result.outcome === "missing" ? "new" : "ended"), 302);
      } catch (error) {
        // Logs an unexpected failure by name only; a navigation always gets a page, never JSON.
        handlePwaError(error instanceof Error ? error : new Error("UnknownError"), c);
        return c.redirect(stateUrl("unavailable"), 302);
      }
    })
    .post("/session/renew", async (c) => {
      // Without the app, no phone may renew; 503 never signs a phone out.
      requireShell(c);
      const [result, web] = await Promise.all([
        service.renew(c, { deviceKey: getCookie(c, PWA_COOKIES.device), appSession: await appSession(c) }),
        webSession(c),
      ]);
      if (result.outcome === "missing" || result.outcome === "ended") {
        clearAppCredentials(c);
        return pwaErrorResponse(c, new PwaError("UNPAIRED", 401));
      }
      if (result.outcome === "blocked") return pwaErrorResponse(c, new PwaError("ACCOUNT_BLOCKED", 403));
      if (result.outcome === "renewed") setAppCredentials(c, result.credentials);
      // Android shares Chrome's cookies with the app: fetches may run as that other web account.
      const otherAccount = web && web.user.id !== result.userId ? { name: web.user.displayName || web.user.uid } : undefined;
      return c.json({ renewed: result.outcome === "renewed", ...(otherAccount ? { otherAccount } : {}) });
    })
    .patch("/session", v("json", PwaRenameSchema, pwaInvalidRequest), async (c) => {
      await service.rename(getCookie(c, PWA_COOKIES.device), c.req.valid("json").name);
      return c.body(null, 204);
    })
    .delete("/session", async (c) => {
      await service.unpair(getCookie(c, PWA_COOKIES.device));
      clearAppCredentials(c);
      // A pairing confirmed before the sign-out must not finish on its own later.
      clearPairing(c);
      return c.body(null, 204);
    });
};
