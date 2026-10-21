import { type AuthContext, auth, middleware, rateLimit, respond } from "@k2b/cloud/server";
import { Hono } from "hono";
import { PULSE_NOT_CONFIGURED } from "../store/gate";
import { pulseStoreConfigured } from "../store/service";
import adminRoutes from "./routes/admin";
import baseAdminRoutes from "./routes/base-admin";
import basesRoutes from "./routes/bases";
import ingestRoutes from "./routes/ingest";
import sourcesRoutes from "./routes/sources";
import sqlRoutes from "./routes/sql";

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
      return respond(c, { ok: false, status: 503, code: PULSE_NOT_CONFIGURED.code, error: PULSE_NOT_CONFIGURED.message });
    await next();
  })
  .use(rateLimit())
  .route("/", ingestRoutes)
  .use(auth.requireRole("authenticated"))
  .route("/admin/store", adminRoutes)
  .route("/admin", baseAdminRoutes)
  .route("/", basesRoutes)
  .route("/", sourcesRoutes)
  .route("/", sqlRoutes);

export default app;
export type ApiType = typeof app;
