import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import weatherDetailPage from "./[id]/page";
import weatherAdminPage from "./admin";
import weatherDisplayPage from "./display/page";
import weatherPage from "./page";

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...weatherAdminPage);

export default new Hono<AuthContext>()
  // Public display endpoint (no auth) - must be before /:id
  .get("/display", ...weatherDisplayPage)
  // Protected routes (require auth)
  .get("/", auth.requireRole("user", ssr.access), ...weatherPage)
  .get("/:id", auth.requireRole("user", ssr.access), ...weatherDetailPage);
