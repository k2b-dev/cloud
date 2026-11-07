import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import spaceDetailPage from "./[id]/page";
import spacesAdminPage from "./admin";
import cloudCalendarPage from "./calendar/page";
import spacesPage from "./page";

export const adminPages = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .get("/", auth.requireRole("admin", ssr.access), ...spacesAdminPage);

export default new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .get("/", auth.requireRole("user", ssr.access), ...spacesPage)
  .get("/calendar", auth.requireRole("user", ssr.access), ...cloudCalendarPage)
  .get("/:id", auth.requireRole("user", ssr.access), ...spaceDetailPage);
