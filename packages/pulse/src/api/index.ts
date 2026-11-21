import { type AuthContext, auth, jsonResponse, middleware, rateLimit, respond } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { PULSE_NOT_CONFIGURED } from "../store/gate";
import { pulseStoreConfigured } from "../store/service";
import adminRoutes from "./routes/admin";
import alertsRoutes from "./routes/alerts";
import baseAdminRoutes from "./routes/base-admin";
import basesRoutes from "./routes/bases";
import ingestRoutes from "./routes/ingest";
import sourcesRoutes from "./routes/sources";
import sqlRoutes from "./routes/sql";

// Shared dashboard links outlive the removed dashboards. They answer before the store gate and never look anything up.
const removedLink = describeRoute({
  tags: ["Pulse"],
  summary: "Removed shared dashboard link",
  responses: { 410: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Shared dashboards were removed") },
});
const linkRemoved = (c: Context<AuthContext>) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.json({ code: "GONE", message: "This link is no longer valid. Shared Pulse dashboards were removed." }, 410);
};

const app = new Hono<AuthContext>()
  // Ingest-only sources write free-text dimensions, attributes and states that most Pulse reads return next to other sources' data.
  .use("*", middleware.noTransform())
  .use("/public/*", auth.requireRole("*"))
  .get("/public/:token", removedLink, linkRemoved)
  .get("/public/:token/*", removedLink, linkRemoved)
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
  .route("/", sqlRoutes)
  .route("/", alertsRoutes);

export default app;
export type ApiType = typeof app;
