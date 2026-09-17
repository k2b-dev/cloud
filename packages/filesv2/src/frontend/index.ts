import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import adminPage from "./admin";
import filesPage from "./page";

export default new Hono<AuthContext>()
  .get("/app/filesv2", auth.requireRole("user", ssr.access), ...filesPage)
  .get("/admin/filesv2", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/app/filesv2/*", auth.requireRole("user", ssr.access), (c) => ssr.error(c, 404))
  .get("/admin/filesv2/*", auth.requireRole("admin", ssr.access), (c) => ssr.error(c, 404));
