import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import faqAdminPage from "./admin-page";
import faqPage from "./page";

/** Public-facing pages mounted at `/faq` — visible to anyone. */
export const publicRoutes = new Hono<AuthContext>().get("/", auth.requireRole("*"), ...faqPage);

/** Admin pages mounted at `/admin/faq` — admin-only list + create + edit + delete. */
export const adminRoutes = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...faqAdminPage);

// Default export = public routes (kept for callers that import the default).
export default publicRoutes;
