import { type AuthContext, middleware, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { pulseCapabilities } from "./capabilities";
import { app, ssr } from "./config";
import pageRoutes from "./frontend";
import { pulseHelp } from "./help";
import { migrate } from "./migrate";
import { pulseService } from "./service";
import { pulseRuntime } from "./service/runtime";

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/pulse", apiRoutes)
  .route("/app/pulse", pageRoutes);

router.get("/app/pulse/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  capabilities: pulseCapabilities,
  help: pulseHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
    start: async () => {
      await pulseRuntime.start();
    },
    stop: async () => {
      await pulseRuntime.stop();
    },
  },
});

export type { ApiType } from "./api";
export { pulseService as service };
