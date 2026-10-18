import { type AuthContext, auth, middleware, rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import basesRoutes from "./routes/bases";
import dashboardsRoutes from "./routes/dashboards";
import publicRoutes from "./routes/public";
import queriesRoutes from "./routes/queries";
import savedQueryRoutes from "./routes/saved-queries";
import signalsRoutes from "./routes/signals";
import sourcesRoutes from "./routes/sources";

const app = new Hono<AuthContext>()
  .use("/bases", middleware.noTransform())
  .use("/query/event-map", middleware.noTransform())
  .use("/query/event-map/*", middleware.noTransform())
  .use("/query/metric-text", middleware.noTransform())
  .use("/query/metric-text/*", middleware.noTransform())
  .use("/bases/:baseId/inventory", middleware.noTransform())
  .use("/bases/:baseId/inventory/*", middleware.noTransform())
  .use("/bases/:baseId/resource-events", middleware.noTransform())
  .use("/bases/:baseId/resource-events/*", middleware.noTransform())
  .use("/bases/:baseId/resource-states", middleware.noTransform())
  .use("/bases/:baseId/resource-states/*", middleware.noTransform())
  .use("/bases/:baseId/recent-events", middleware.noTransform())
  .use("/bases/:baseId/recent-events/*", middleware.noTransform())
  .use("/bases/:baseId/states", middleware.noTransform())
  .use("/bases/:baseId/states/*", middleware.noTransform())
  .use("/dashboards/:dashboardId/snapshot", middleware.noTransform())
  .use("/dashboards/:dashboardId/snapshot/*", middleware.noTransform())
  .use("/public-dashboard/:token", middleware.noTransform())
  .use("/public-dashboard/:token/*", middleware.noTransform())
  .use(rateLimit())
  .route("/", publicRoutes)
  .use(auth.requireRole("authenticated"))
  .route("/", basesRoutes)
  .route("/", sourcesRoutes)
  .route("/", signalsRoutes)
  .route("/", savedQueryRoutes)
  .route("/", dashboardsRoutes)
  .route("/", queriesRoutes);

export default app;
export type ApiType = typeof app;
