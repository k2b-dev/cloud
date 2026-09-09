import { auth, rateLimit, type AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import basesRoutes from "./routes/bases";
import dashboardsRoutes from "./routes/dashboards";
import publicRoutes from "./routes/public";
import queriesRoutes from "./routes/queries";
import savedQueryRoutes from "./routes/saved-queries";
import signalsRoutes from "./routes/signals";
import sourcesRoutes from "./routes/sources";

const app = new Hono<AuthContext>()
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
