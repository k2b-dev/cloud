/**
 * Bun.serve() adapter - provides routes object for native Bun server.
 * Serves island chunks from _ssr and dev tools endpoints.
 */
import type { SsrConfig } from "../index";
import { createAssetResponse, createPingResponse, createReloadResponse, getAssetPrefix, getSsrDir, notFound } from "./utils";

type RouteHandler = (req: Request) => Response | Promise<Response>;
type Routes = Record<string, RouteHandler>;

/**
 * Creates routes for Bun.serve from SSR config.
 *
 * @example
 * ```ts
 * import { routes } from "@k2b/ssr/bun";
 * serve({
 *   routes: {
 *     ...routes(config),
 *     "/": () => html(() => <Home />),
 *   },
 * });
 * ```
 */
export const routes = (config: SsrConfig): Routes => {
  const { dev, ssrPath } = config;
  const ssrDir = getSsrDir(config);

  const devRoutes: Routes = dev
    ? {
        [`${ssrPath}/_reload`]: (req) => createReloadResponse(req.signal),
        [`${ssrPath}/_ping`]: () => createPingResponse(),
      }
    : {};

  const serveAsset: RouteHandler = (req) => {
    const filename = new URL(req.url).pathname.slice(ssrPath.length + 1);
    return createAssetResponse(req, ssrDir, filename, dev);
  };
  // The route key cannot name the version: the manifest is read per request.
  const serveVersionedAsset: RouteHandler = (req) => {
    const [version, filename = ""] = new URL(req.url).pathname.slice(ssrPath.length + 1).split("/");
    return `/${version}` === getAssetPrefix(config) ? createAssetResponse(req, ssrDir, filename, dev) : notFound();
  };

  return dev
    ? { ...devRoutes, [`${ssrPath}/*.js`]: serveAsset, [`${ssrPath}/*.js.map`]: serveAsset }
    : { [`${ssrPath}/:version/:filename`]: serveVersionedAsset };
};
