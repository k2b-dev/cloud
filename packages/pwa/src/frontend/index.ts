import { PWA_MANIFEST_PATH, PWA_SCOPE, PWA_SERVICE_WORKER_PATH } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import { manifestResponse, offlineResponse, serviceWorkerResponse } from "./installable";
import settingsPage from "./settings.page";
import startPage from "./start.page";

/**
 * The shell's routes below `/pwa`. Applications own `/pwa/<app-id>` and Core owns `/pwa/_auth`; the gateway routes
 * those longer prefixes past the shell.
 */
export const shellRoutes = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    await next();
    // No shell page may be framed, and none leaks its address to another site.
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  })
  // Outside the manifest scope; only `/pwa/` belongs to the app.
  .get("/pwa", (c) => c.redirect(PWA_SCOPE, 308))
  // Only app sessions count below /pwa/; the page decides what a phone without one sees.
  .get(PWA_SCOPE, auth.requireRole("*"), ...startPage)
  .get(`${PWA_SCOPE}settings`, auth.requireRole("authenticated", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...settingsPage)
  .get(`${PWA_SCOPE}offline`, offlineResponse)
  .get(PWA_MANIFEST_PATH, manifestResponse)
  .get(PWA_SERVICE_WORKER_PATH, serviceWorkerResponse)
  .get(`${PWA_SCOPE}*`, auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "pwa" }));
