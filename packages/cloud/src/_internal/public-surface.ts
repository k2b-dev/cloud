import type { Server } from "bun";
import type { Handler, Hono } from "hono";
import { isCloudCredentialCookie, normalizeAppDomainHost, PUBLIC_HOST_HEADER, PUBLIC_SURFACE_PREFIX } from "../contracts/app-domains";
import { canonicalRoute } from "./app-path";

type RequestServer = Pick<Server<unknown>, "upgrade" | "requestIP" | "timeout">;
const isRequestServer = (value: unknown): value is RequestServer =>
  typeof value === "object" &&
  value !== null &&
  "upgrade" in value &&
  typeof value.upgrade === "function" &&
  "requestIP" in value &&
  typeof value.requestIP === "function" &&
  "timeout" in value &&
  typeof value.timeout === "function";

/** Bun associates transport operations with its native Request, before the public-origin view is built. */
const publicEnvironment = (environment: object | undefined, request: Request, original: Request): object | undefined => {
  if (!environment) return environment;
  const bindServer = (server: RequestServer) =>
    new Proxy(server, {
      get(target, property) {
        const native = (candidate: Request) => (candidate === request ? original : candidate);
        if (property === "upgrade")
          return (candidate: Request, options: Parameters<RequestServer["upgrade"]>[1]) => target.upgrade(native(candidate), options);
        if (property === "requestIP") return (candidate: Request) => target.requestIP(native(candidate));
        if (property === "timeout") return (candidate: Request, seconds: number) => target.timeout(native(candidate), seconds);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  if (isRequestServer(environment)) return bindServer(environment);
  if ("server" in environment && isRequestServer(environment.server)) {
    const server = bindServer(environment.server);
    return new Proxy(environment, {
      get: (target, property) => (property === "server" ? server : Reflect.get(target, property, target)),
    });
  }
  return environment;
};

/** Framework mounts must never be advertised as application routes. */
export const validatePublicSurfaceRoutes = (routes: readonly string[]): void => {
  for (const route of routes) {
    const path = new URL(canonicalRoute(decodeURIComponent(route).replaceAll("\\", "/")), "https://cloud.invalid").pathname;
    if (path === PUBLIC_SURFACE_PREFIX || path.startsWith(`${PUBLIC_SURFACE_PREFIX}/`)) {
      throw new Error(`Route "${route}" uses the reserved ${PUBLIC_SURFACE_PREFIX} prefix`);
    }
  }
};

/** Dispatch before Cloud context/authentication, using a fresh public-origin request. */
export const createPublicSurfaceHandler =
  (router: Pick<Hono, "fetch"> | undefined, development: boolean): Handler =>
  (c) => {
    const authority = c.req.header(PUBLIC_HOST_HEADER);
    const parts = authority?.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
    const host = parts?.[1];
    if (!router || !authority || !host || normalizeAppDomainHost(host) !== host || (parts?.[2] && Number(parts[2]) > 65535))
      return c.notFound();
    const original = new URL(c.req.url);
    const url = new URL(`${development && host.endsWith(".localhost") ? "http" : "https"}://${authority}`);
    url.pathname = original.pathname.slice(PUBLIC_SURFACE_PREFIX.length) || "/";
    url.search = original.search;
    const headers = new Headers(c.req.raw.headers);
    const cookies = headers
      .get("cookie")
      ?.split(";")
      .filter((cookie) => !isCloudCredentialCookie(cookie.split("=", 1)[0]!.trim()));
    if (cookies?.some((cookie) => cookie.trim())) headers.set("cookie", cookies.join(";").trim());
    else headers.delete("cookie");
    headers.delete(PUBLIC_HOST_HEADER);
    headers.set("host", authority);
    const request = new Request(url, new Request(c.req.raw, { headers }));
    return router.fetch(request, publicEnvironment(c.env, request, c.req.raw));
  };
