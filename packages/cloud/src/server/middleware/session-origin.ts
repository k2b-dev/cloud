import { createMiddleware } from "hono/factory";
import { TrieRouter } from "hono/router/trie-router";
import { PUBLIC_SURFACE_PREFIX } from "../../contracts/app-domains";
import { PWA_COOKIES } from "../../contracts/pwa";
import * as settings from "../../services/settings";
import { publicCloudOrigin } from "../../shared/app-url";

const sessionCookies = new Set(["session_token", PWA_COOKIES.session]);
const refusedSocketOrigins = new WeakSet<Request>();

/** Survives nested Hono routers without adding a client-controlled header. */
export const hasRefusedSessionOrigin = (request: Request): boolean => refusedSocketOrigins.has(request);

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Installed by app.start() before every framework and application route. */
export const sessionOriginGuard = (
  sessionlessRoutes: readonly string[] = [],
  getPublicUrl: () => Promise<string> = () => settings.get<string>("app.url"),
) => {
  const router = new TrieRouter<boolean>();
  for (const path of sessionlessRoutes) {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path) || path === "/" || path === "/*")
      throw new Error(`Invalid sessionless route: ${path}`);
    router.add("ALL", path, true);
  }
  /**
   * Whether a browser sent the request from a page of the public Cloud origin. Session cookies are host-only, so a
   * request that carries one and that the browser marks `same-origin` comes from such a page. A page served with
   * `Referrer-Policy: no-referrer` sends `Origin: null` on its own form posts; the browser still sets
   * `Sec-Fetch-Site: same-origin`, which no page can set or change, so that pair is accepted. Any other request needs
   * the public origin itself: `same-site` and `cross-site` never pass, and a request with neither header, such as a
   * non-browser client that carries a cookie, is refused, because it cannot show where it comes from. Such clients
   * use a bearer token instead.
   */
  const fromPublicOrigin = async (site: string | undefined, origin: string | undefined) => {
    if (site === "same-site" || site === "cross-site") return false;
    if (site === "same-origin" && (origin === undefined || origin === "null")) return true;
    return origin === publicCloudOrigin(await getPublicUrl());
  };
  return createMiddleware(async (c, next) => {
    const cookies = c.req.header("Cookie")?.split(";") ?? [];
    const retained = cookies.filter((cookie) => !sessionCookies.has(cookie.split("=", 1)[0]!.trim()));
    if (retained.length === cookies.length) return next();

    const stripSessionCookies = () => {
      if (retained.length) c.req.raw.headers.set("Cookie", retained.join(";"));
      else c.req.raw.headers.delete("Cookie");
    };

    // An explicit credential never falls back to an attached browser session.
    // Remove only Cloud session cookies; protocol-specific cookies remain intact.
    // Mutate headers rather than copy the Request: Bun needs its identity for
    // requestIP, websocket upgrades, timeouts and disconnect cancellation.
    // The reserved public surface never has Cloud session authority. Its
    // framework handler strips Cloud credential cookies before app.public runs.
    const publicSurface = c.req.path === PUBLIC_SURFACE_PREFIX || c.req.path.startsWith(`${PUBLIC_SURFACE_PREFIX}/`);
    if (publicSurface || /^Bearer\s+\S+$/i.test(c.req.header("Authorization") ?? "") || router.match("ALL", c.req.path)[0].length > 0) {
      stripSessionCookies();
      return next();
    }
    const socket = c.req.header("Upgrade")?.toLowerCase() === "websocket";
    if (!mutationMethods.has(c.req.method) && !socket) return next();

    if (!(await fromPublicOrigin(c.req.header("Sec-Fetch-Site"), c.req.header("Origin")))) {
      if (socket) {
        // No session authority reaches a socket handler. Live routes can still
        // accept and close with 1008: the gateway makes failed handshakes retryable.
        stripSessionCookies();
        refusedSocketOrigins.add(c.req.raw);
        return next();
      }
      return c.json({ code: "INVALID_ORIGIN", message: "Cookie-authenticated requests require the public Cloud origin" }, 403);
    }
    return next();
  });
};
