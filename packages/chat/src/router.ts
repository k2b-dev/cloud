import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { ssr } from "./config";
import pageRoutes, { adminPages, pwaPages } from "./frontend";

export const router = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/chat", apiRoutes)
  .route("/app/chat", pageRoutes)
  .route("/admin/chat", adminPages)
  .route("/pwa/chat", pwaPages);

router.get("/app/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/pwa/chat/*", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "pwa" }));
