import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import adminPageRoutes from "./frontend";
import { proxyAuthHelp } from "./help";
import { migrate } from "./migrate";
import { proxyAuthService } from "./service";
import verifyRoutes from "./verify";

// Verify lives at the top-level `/proxy-auth/verify/:clientId` because
// Traefik forward-auth expects a configurable URL on the public origin.
const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/proxy-auth", apiRoutes)
  .route("/admin/proxy-auth", adminPageRoutes)
  .route("/proxy-auth", verifyRoutes);

router.get("/admin/proxy-auth/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  help: proxyAuthHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});
export type { ApiType } from "./api";
export type { ProxyAuthService } from "./service";
export { proxyAuthService as service };
