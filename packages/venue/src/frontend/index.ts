import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import venueDetailPage from "./[id]/page";
import venuePage from "./page";
import publicVenueFeedbackPage from "./public/[slug]/feedback/page";
import publicVenuePage from "./public/[slug]/page";

export default new Hono<AuthContext>()
  .get("/public/:id/feedback", ...publicVenueFeedbackPage)
  .get("/public/:id", ...publicVenuePage)
  .get("/", auth.requireRole("user", ssr.access), ...venuePage)
  .get("/:id/public-sections/:sectionId", auth.requireRole("user", ssr.access), ...venueDetailPage)
  .get("/:id/:view", auth.requireRole("user", ssr.access), ...venueDetailPage)
  .get("/:id", auth.requireRole("user", ssr.access), ...venueDetailPage);
