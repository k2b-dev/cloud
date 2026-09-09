import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import basePage from "./[baseId]/page";
import queryReferencePage from "./[baseId]/query-reference/page";
import page from "./page";
import publicPage from "./public-page";

export default new Hono<AuthContext>()
  .get("/display/:token", ...publicPage)
  .get("/:baseId/dashboards/:dashboardId/edit", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/dashboards/:dashboardId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/sources/:sourceId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/sources", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/resources/:resourceKey", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/resources", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/query-reference", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/:baseId/explorer", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/metrics/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/states/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/events/:signalId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/signals/events", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/signals/states", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/signals/metrics", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId/signals", auth.requireRole("user", ssr.access), ...basePage)
  .get("/:baseId", auth.requireRole("user", ssr.access), ...basePage)
  .get("/", auth.requireRole("user", ssr.access), ...page);
