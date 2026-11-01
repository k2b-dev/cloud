import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import basePage from "./[baseId]/page";
import { pulseNotSetUpGate } from "./not-set-up";
import page from "./page";
import publicDashboard from "./public-dashboard";

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
  .get("/public/:token", auth.requireRole("*", ssr.access), ...publicDashboard)
  // Authentication runs first: it resolves the actor the gate needs and keeps the sign-in redirect.
  .use("*", auth.requireRole("user", ssr.access), pulseNotSetUpGate())
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .route("/:baseId", workspacePages);
