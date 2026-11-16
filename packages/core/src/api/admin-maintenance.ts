import {
  MaintenanceBypassSchema,
  MaintenanceOnInputSchema,
  MaintenanceStatusSchema,
  MaintenanceUntilInputSchema,
} from "@k2b/cloud/contracts/maintenance";
import { type AuthContext, auth, jsonResponse, middleware, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
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
      describeRoute({
        tags: ["Maintenance"],
        summary: "Read the maintenance mode state and how many apps are registered",
        ...requiresAdmin,
        responses: { 200: jsonResponse(MaintenanceStatusSchema, "Maintenance state") },
      }),
      (c) => respond(c, () => service.status(c.get("user"))),
    )
    .post(
      "/on",
      describeRoute({
        tags: ["Maintenance"],
        summary: "Switch maintenance mode on, or change its message and planned end while it is on",
        ...requiresAdmin,
        responses: { 200: jsonResponse(MaintenanceStatusSchema, "Maintenance state") },
      }),
      bodyLimit({ maxSize: 8 * 1024 }),
      v("json", MaintenanceOnInputSchema),
      (c) => respond(c, () => service.on(c.get("user"), c.req.valid("json"))),
    )
    .post(
      "/until",
      describeRoute({
        tags: ["Maintenance"],
        summary: "Change the planned end of the running maintenance",
        ...requiresAdmin,
        responses: { 200: jsonResponse(MaintenanceStatusSchema, "Maintenance state"), 409: { description: "Maintenance is not active" } },
      }),
      bodyLimit({ maxSize: 1024 }),
      v("json", MaintenanceUntilInputSchema),
      (c) => respond(c, () => service.setUntil(c.get("user"), c.req.valid("json").until)),
    )
    .post(
      "/bypass",
      describeRoute({
        tags: ["Maintenance"],
        summary: "Get a personal link that lets you past the running maintenance on the Cloud host; you still sign in as usual",
        ...requiresAdmin,
        responses: {
          200: jsonResponse(MaintenanceBypassSchema, "Link and its expiry"),
          409: { description: "Maintenance is not active" },
        },
      }),
      (c) => respond(c, () => service.bypass(c.get("user"))),
    )
    .post(
      "/off",
      describeRoute({
        tags: ["Maintenance"],
        summary: "Switch maintenance mode off; open maintenance pages reload",
        ...requiresAdmin,
        responses: { 200: jsonResponse(MaintenanceStatusSchema, "Maintenance state") },
      }),
      (c) => respond(c, () => service.off(c.get("user"))),
    );
