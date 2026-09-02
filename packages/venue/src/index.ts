import { type AuthContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes, { venueTodayWidgetHandler } from "./api";
import { venueCapabilities } from "./capabilities";
import { app } from "./config";
import pageRoutes from "./frontend";
import { venueHelp } from "./help";
import { migrate } from "./migrate";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

export default await app.start({
  capabilities: venueCapabilities,
  fetch: router.fetch,
  help: venueHelp,
  openapi: apiRoutes,
  widgets: { today: venueTodayWidgetHandler },
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});

export type { ApiType } from "./api";
