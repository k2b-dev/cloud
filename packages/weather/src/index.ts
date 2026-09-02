import { type AppContext, type AuthContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { currentWeatherWidgetHandler } from "./api/widgets";
import { weatherCapabilities } from "./capabilities";
import { app } from "./config";
import pageRoutes, { adminPages as adminPageRoutes } from "./frontend";
import { weatherHelp } from "./help";

/** Per-app Hono context: AuthContext + typed snapshot with weather.* + core.* settings. */
export type WeatherAppContext = AppContext<typeof app>;

// weather business logic + DB migrations live in cloud-lib (see
// `packages/cloud/src/services/weather/`) so other apps (e.g. spaces) can
// consume the same service in-process. core-app runs the migration at boot;
// this app is now just routes + UI + admin.
const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/weather", apiRoutes)
  .route("/app/weather", pageRoutes)
  .route("/admin/weather", adminPageRoutes);

export default await app.start({
  capabilities: weatherCapabilities,
  fetch: router.fetch,
  help: weatherHelp,
  openapi: apiRoutes,
  widgets: { current: currentWeatherWidgetHandler },
});
export type { ApiType } from "./api";
