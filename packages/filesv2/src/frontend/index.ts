import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import adminPage from "./admin";
import filesPage from "./page";
import { publicInboxPage, publicSharePage } from "./public-pages";
import sharesPage from "./shares-page";

export default new Hono<AuthContext>()
  .get("/app/filesv2", auth.requireRole("user", ssr.access), ...filesPage)
  .get("/app/filesv2/shares", auth.requireRole("user", ssr.access), ...sharesPage)
  .get("/share/filesv2/s/:token", auth.requireRole("*"), ...publicSharePage)
  .get("/share/filesv2/inbox/:token", auth.requireRole("*"), ...publicInboxPage)
  .get("/admin/filesv2", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/app/filesv2/*", auth.requireRole("user", ssr.access), (c) => ssr.error(c, 404))
  .get("/admin/filesv2/*", auth.requireRole("admin", ssr.access), (c) => ssr.error(c, 404));
