import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import venueDetailPage from "./[id]/page";
import venueSettingsPage from "./[id]/settings.page";
import venuePage from "./page";
import publicVenueFeedbackPage from "./public/[slug]/feedback/page";
import publicVenuePage from "./public/[slug]/page";

export default new Hono<AuthContext>()
  .use("/", middleware.noTransform())
  .get("/public/:id/feedback", ...publicVenueFeedbackPage)
  .get("/public/:id", ...publicVenuePage)
  .use("/:id/*", middleware.noTransform())
  .get("/", auth.requireRole("user", ssr.access), ...venuePage)
  .get("/:id/settings/:tab", auth.requireRole("user", ssr.access), ...venueSettingsPage)
  .get("/:id/settings", auth.requireRole("user", ssr.access), ...venueSettingsPage)
  .get("/:id/public-sections/:sectionId", auth.requireRole("user", ssr.access), ...venueDetailPage)
  .get("/:id/:view", auth.requireRole("user", ssr.access), ...venueDetailPage)
  .get("/:id", auth.requireRole("user", ssr.access), ...venueDetailPage);
