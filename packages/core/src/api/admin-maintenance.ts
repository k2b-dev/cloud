import { MaintenanceOnInputSchema, MaintenanceUntilInputSchema } from "@k2b/cloud/contracts/maintenance";
import { type AuthContext, auth, middleware, respond, v } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMaintenanceService, type MaintenanceService } from "../maintenance";

/**
 * `/api/admin/maintenance` (MAINTENANCE_ADMIN_API_PATH). The gateway passes exactly this path to Core during
 * maintenance, so these routes are how an administrator ends it again.
 */
export const createAdminMaintenanceRoutes = (
  service: MaintenanceService = createMaintenanceService(),
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
) =>
  new Hono<AuthContext>()
    .use("*", middleware.noTransform())
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      return next();
    })
    .use("*", authenticate)
    .use("*", async (c, next) => (c.req.method === "GET" ? next() : auth.requireOAuthScope("write", "admin")(c, next)))
    .get(
      "/",
      middleware.openapi({ tags: ["Maintenance"], summary: "Read the maintenance mode state and how many apps are registered" }),
      (c) => respond(c, () => service.status(c.get("user"))),
    )
    .post(
      "/on",
      middleware.openapi({
        tags: ["Maintenance"],
        summary: "Switch maintenance mode on, or change its message and planned end while it is on",
      }),
      bodyLimit({ maxSize: 8 * 1024 }),
      v("json", MaintenanceOnInputSchema),
      (c) => respond(c, () => service.on(c.get("user"), c.req.valid("json"))),
    )
    .post(
      "/until",
      middleware.openapi({ tags: ["Maintenance"], summary: "Change the planned end of the running maintenance" }),
      bodyLimit({ maxSize: 1024 }),
      v("json", MaintenanceUntilInputSchema),
      (c) => respond(c, () => service.setUntil(c.get("user"), c.req.valid("json").until)),
    )
    .post(
      "/bypass",
      middleware.openapi({ tags: ["Maintenance"], summary: "Get a personal link that lets you past the running maintenance on the Cloud host; you still sign in as usual" }),
      (c) => respond(c, () => service.bypass(c.get("user"))),
    )
    .post(
      "/off",
      middleware.openapi({ tags: ["Maintenance"], summary: "Switch maintenance mode off; open maintenance pages reload" }),
      (c) => respond(c, () => service.off(c.get("user"))),
    );
