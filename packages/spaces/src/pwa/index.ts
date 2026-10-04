import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import myTasksPage from "./page";

/** The Spaces part of the mobile app below `/pwa/spaces`; only an app session reaches it. */
export const pwaRoutes = new Hono<AuthContext>().get(
  "/",
  auth.requireRole("user", ssr.pwaAccess),
  auth.requireUser(ssr.pwaAccess),
  ...myTasksPage,
);
