import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import basePage from "./[baseId]/page";
import queryReferencePage from "./[baseId]/query-reference/page";
import page from "./page";
import publicPage from "./public-page";

const workspacePages = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
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

export default new Hono<AuthContext>()
  .use("/", middleware.noTransform())
  .use("/display/:token", middleware.noTransform())
  .use("/display/:token/*", middleware.noTransform())
  .get("/display/:token", ...publicPage)
  .get("/:baseId/query-reference", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .route("/:baseId", workspacePages);
