import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { spacesTodayWidgetHandler } from "./api/widgets";
import { spacesCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { spacesHelp } from "./help";
import { migrate } from "./migrate";
import { pwaRoutes } from "./pwa";
import { spacesService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/spaces", apiRoutes)
  .route("/app/spaces", pageRoutes)
  .route("/admin/spaces", adminPageRoutes)
  .route("/pwa/spaces", pwaRoutes);

router.get("/app/spaces/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/admin/spaces/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
router.get("/pwa/spaces/*", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "pwa" }));

const result = await app.start({
  capabilities: spacesCapabilities,
  fetch: router.fetch,
  help: spacesHelp,
  openapi: apiRoutes,
  widgets: { today: spacesTodayWidgetHandler },
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});
export default { ...result, websocket };
export type { ApiType } from "./api";
export { spacesService as service };
