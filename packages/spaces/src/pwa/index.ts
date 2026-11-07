import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import { myTasksPage, spacePage, taskPage } from "./page";

/** The Spaces part of the mobile app below `/pwa/spaces`; only an app session reaches it. */
export const pwaRoutes = new Hono<AuthContext>()
  // Task titles and people's names stand beside each other here, as on the web pages.
  .use("*", middleware.noTransform())
  .get("/", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...myTasksPage)
  .get("/:space", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...spacePage)
  .get("/:space/:task", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...taskPage);
