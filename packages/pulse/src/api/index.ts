import { type AuthContext, auth, middleware, rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import { PULSE_NOT_CONFIGURED } from "../store/gate";
import { pulseStoreConfigured } from "../store/service";
import adminRoutes from "./routes/admin";
import baseAdminRoutes from "./routes/base-admin";
import basesRoutes from "./routes/bases";
import dashboardsRoutes from "./routes/dashboards";
import publicRoutes from "./routes/public";
import queriesRoutes from "./routes/queries";
import savedQueryRoutes from "./routes/saved-queries";
import signalsRoutes from "./routes/signals";
import sourcesRoutes from "./routes/sources";

const app = new Hono<AuthContext>()
  // Ingest-only sources write free-text dimensions, attributes and states that most Pulse reads return next to other sources' data.
  .use("*", middleware.noTransform())
  .use("*", async (c, next) => {
    const path = c.req.path;
    if (
      !/^(?:\/api\/pulse)?\/admin(?:\/|$)/.test(path) &&
      !/^(?:\/api\/pulse)?\/(?:openapi\.json|health)\/?$/.test(path) &&
      !(await pulseStoreConfigured())
    )
      return c.json(PULSE_NOT_CONFIGURED, 503);
    await next();
  })
  .use(rateLimit())
  .route("/", publicRoutes)
  .use(auth.requireRole("authenticated"))
  .route("/admin/store", adminRoutes)
  .route("/admin", baseAdminRoutes)
  .route("/", basesRoutes)
  .route("/", sourcesRoutes)
  .route("/", signalsRoutes)
  .route("/", savedQueryRoutes)
  .route("/", dashboardsRoutes)
  .route("/", queriesRoutes);

export default app;
export type ApiType = typeof app;
