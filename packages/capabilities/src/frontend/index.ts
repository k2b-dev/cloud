import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import page from "./page";
import workspacePage from "./workspace.page";

const requireAuth = auth.requireRole("authenticated", ssr.access);

export default new Hono<AuthContext>()
  .get("/", requireAuth, ...page)
  .get("/:appId/:kind{query|action}/:capabilityId", requireAuth, ...workspacePage)
  .get("/:appId", requireAuth, ...workspacePage);
