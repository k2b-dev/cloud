import { type AuthContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { spacesTodayWidgetHandler } from "./api/widgets";
import { spacesCapabilities } from "./capabilities";
import { app } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { spacesHelp } from "./help";
import { migrate } from "./migrate";
import { spacesService } from "./service";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/spaces", apiRoutes)
  .route("/app/spaces", pageRoutes)
  .route("/admin/spaces", adminPageRoutes);

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
