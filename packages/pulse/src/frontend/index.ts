import { type AuthContext, auth, getLocale, middleware } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { ssr } from "../config";
import { pulseMessages } from "../messages";
import basePage from "./[baseId]/page";
import { pulseNotSetUpGate } from "./not-set-up";
import page from "./page";

/** Shared dashboard links outlive the removed dashboards. The page never looks up or names the dashboard. */
export const removedPublicLink = (c: Context<AuthContext>) => {
  const { t } = pulseMessages.resolve([getLocale(c)]);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  return ssr.error(c, 410, { title: t.publicLinkRemovedTitle, description: t.publicLinkRemovedDetail, layout: "minimal" });
};
const workspacePages = new Hono<AuthContext>()
  .get("/sql", auth.requireRole("user", ssr.access), ...basePage)
  .get("/sql/:queryId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/dashboards", auth.requireRole("user", ssr.access), ...basePage)
  .get("/dashboards/:dashboardId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/sources/:sourceId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/sources", auth.requireRole("user", ssr.access), ...basePage)
  .get("/", auth.requireRole("user", ssr.access), ...basePage);

// Source names and diagnostics are externally supplied text.
export default new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .get("/public/:token", auth.requireRole("*", ssr.access), removedPublicLink)
  // Authentication runs first: it resolves the actor the gate needs and keeps the sign-in redirect.
  .use("*", auth.requireRole("user", ssr.access), pulseNotSetUpGate())
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .route("/:baseId", workspacePages);
