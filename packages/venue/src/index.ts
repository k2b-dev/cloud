import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes, { venueTodayWidgetHandler } from "./api";
import { venueCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { venueHelp } from "./help";
import { migrate } from "./migrate";
import { menuImageCleanup } from "./service/menu-images";
import { shiftNoticeScheduler } from "./shift-notices";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

router.get("/app/venue/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

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
    start: async () => {
      await shiftNoticeScheduler.start();
      menuImageCleanup.start();
    },
    stop: async () => {
      await menuImageCleanup.stop();
      await shiftNoticeScheduler.stop();
    },
  },
});

export type { ApiType } from "./api";
