import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import basePage from "./[baseId]/page";
import queryReferencePage from "./[baseId]/query-reference/page";
import { pulseNotSetUpGate } from "./not-set-up";
import page from "./page";
import publicPage from "./public-page";

const workspacePages = new Hono<AuthContext>()
  .get("/dashboards/:dashboardId/edit", auth.requireRole("user", ssr.access), ...basePage)
  .get("/dashboards/:dashboardId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/sources/:sourceId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/sources", auth.requireRole("user", ssr.access), ...basePage)
  .get("/resources/:resourceKey", auth.requireRole("user", ssr.access), ...basePage)
  .get("/resources", auth.requireRole("user", ssr.access), ...basePage)
  .get("/explorer", auth.requireRole("user", ssr.access), ...basePage)
  .get("/metrics/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/states/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/events/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/signals/events", auth.requireRole("user", ssr.access), ...basePage)
  .get("/signals/states", auth.requireRole("user", ssr.access), ...basePage)
  .get("/signals/metrics", auth.requireRole("user", ssr.access), ...basePage)
  .get("/signals", auth.requireRole("user", ssr.access), ...basePage)
  .get("/", auth.requireRole("user", ssr.access), ...basePage);

// Every Pulse page embeds event payloads or state strings that ingest-only sources write.
export default new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .get("/display/:token", pulseNotSetUpGate({ publicDisplay: true }), ...publicPage)
  // Authentication runs first: it resolves the actor the gate needs and keeps the sign-in redirect.
  .use("*", auth.requireRole("user", ssr.access), pulseNotSetUpGate())
  .get("/:baseId/query-reference", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .route("/:baseId", workspacePages);
