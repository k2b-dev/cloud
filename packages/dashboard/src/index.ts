import { type AuthContext, auth, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import apiRoutes from "./api";
import { app, ssr } from "./config";
import dashboardPage from "./frontend/page";
import { dashboardHelp } from "./help";
import { migrate } from "./migrate";

const pageRoutes = new Hono<AuthContext>().get("/", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...dashboardPage);

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/dashboard", apiRoutes)
  .route("/app/dashboard", pageRoutes);

router.get("/app/dashboard/*", auth.requireRole("*"), (c) => ssr.error(c, 404));

export default await app.start({
  fetch: router.fetch,
  help: dashboardHelp,
  openapi: apiRoutes,
  lifecycle: {
    setup: async () => {
      await migrate();
    },
  },
});
export type { ApiType } from "./api";
export type { DashboardSettingsResult } from "./service";
export { dashboardService as service, dashboardSettingsService, getUserSettings, saveUserSettings } from "./service";
