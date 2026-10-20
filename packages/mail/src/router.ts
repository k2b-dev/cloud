import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { ssr } from "./config";
import pageRoutes from "./frontend";
import adminPage from "./frontend/admin";
import adminSecurityPage from "./frontend/admin-security";
import { publicAttachmentRoutes } from "./frontend/public-attachments";

export const router = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/mail", apiRoutes)
  .route("/app/mail", pageRoutes)
  .get("/admin/mail", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/admin/mail/security", auth.requireRole("admin", ssr.access), ...adminSecurityPage)
  .route("/share/mail", publicAttachmentRoutes);

router.get("/app/mail/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/mail/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
