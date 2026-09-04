import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import spaceDetailPage from "./[id]/page";
import spacesAdminPage from "./admin";
import spacesPage from "./page";

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...spacesAdminPage);

export default new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.access), ...spacesPage)
  .get("/:id", auth.requireRole("user", ssr.access), ...spaceDetailPage);
