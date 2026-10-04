import { logger } from "@k2b/cloud/services";
import { APP_ICON_RETRY_SECONDS, APP_ICON_VARIANTS, type AppIconVariant, appIcons } from "@k2b/cloud/services/branding/app-icons";
import { Hono } from "hono";

const log = logger("branding");

/** True when the request's `If-None-Match` names this entity tag, weakly compared. */
const notModified = (header: string | undefined, etag: string): boolean =>
  !!header && header.split(",").some((tag) => [etag, `W/${etag}`, "*"].includes(tag.trim()));

/**
 * The mobile app's icons, drawn from the installation logo (`/branding/<variant>.png`). Public, like the logo.
 * Browsers revalidate them and get `304` until the logo changes.
 */
export const createAppIconRoutes = (icons: Pick<typeof appIcons, "version" | "render"> = appIcons) => {
  const routes = new Hono();
  for (const variant of Object.keys(APP_ICON_VARIANTS) as AppIconVariant[]) {
    routes.get(`/${variant}.png`, async (c) => {
      const headers = { "Cache-Control": "public, no-cache" };
      const current = `"${await icons.version()}"`;
      if (notModified(c.req.header("If-None-Match"), current)) return c.body(null, 304, { ...headers, ETag: current });
      try {
        const icon = await icons.render(variant);
        return c.body(icon.png, 200, { ...headers, ETag: icon.etag, "Content-Type": "image/png" });
      } catch (error) {
        log.error("App icon rendering failed", { variant, error: error instanceof Error ? error.message : "UnknownError" });
        return c.body(null, 503, { "Cache-Control": "no-store", "Retry-After": String(APP_ICON_RETRY_SECONDS) });
      }
    });
  }
  return routes;
};
