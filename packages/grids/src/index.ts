import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { gridsCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes, { adminRoutes, customAppRoutes, publicRoutes } from "./frontend";
import { gridsHelp } from "./help";
import { migrate } from "./migrate";
import { gridsRuntime } from "./runtime";
import { gridsService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/grids", apiRoutes)
  .route("/app/grids", pageRoutes)
  .route("/admin/grids", adminRoutes)
  .route("/share/grids", publicRoutes)
  .route("/apps", customAppRoutes);

router.get("/app/grids/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/grids/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/share/grids/*", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "minimal" }));
router.get("/apps/*", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "minimal" }));

const result = await app.start({
  capabilities: gridsCapabilities,
  fetch: router.fetch,
  help: gridsHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
    start: gridsRuntime.start,
    stop: gridsRuntime.stop,
  },
});

export default { ...result, websocket };

export type { ApiType } from "./api";
export { gridsService as service };
