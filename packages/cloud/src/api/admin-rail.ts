import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { RailAdminSchema, RailAdminInputSchema } from "../contracts/rail-admin";
import { RAIL_PREFERENCES_MAX_BYTES } from "../contracts/rail-preferences";
import { type AuthContext, auth, jsonResponse, requiresAdmin, v } from "../server";
import { RailAdminError, railShortcuts } from "../services/rail-shortcuts";

export const createAdminRailRoutes = (service = railShortcuts, authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .onError((error, c) => {
      if (error instanceof RailAdminError) return c.json({ message: error.message }, error.status);
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    })
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .delete(
      "/cache",
      describeRoute({
        tags: ["Admin app bar"],
        summary: "Invalidate app bar caches for all users",
        ...requiresAdmin,
        responses: { 204: { description: "Caches invalidated; rebuilt on the next read" } },
      }),
      async (c) => {
        await service.invalidateCache(c.get("user"));
        return c.body(null, 204);
      },
    )
    .get(
      "/",
      describeRoute({
        tags: ["Admin app bar"],
        summary: "Read global app bar shortcuts and audiences",
        ...requiresAdmin,
        responses: { 200: jsonResponse(RailAdminSchema, "Global app bar configuration") },
      }),
      async (c) => c.json(await service.list(c.get("user"))),
    )
    .put(
      "/",
      describeRoute({
        tags: ["Admin app bar"],
        summary: "Save global app bar shortcuts and audiences",
        ...requiresAdmin,
        responses: { 200: jsonResponse(RailAdminSchema, "Saved configuration"), 409: { description: "Configuration changed" } },
      }),
      bodyLimit({ maxSize: RAIL_PREFERENCES_MAX_BYTES }),
      v("json", RailAdminInputSchema),
      async (c) => c.json(await service.save(c.get("user"), c.req.valid("json"))),
    );

export default createAdminRailRoutes();
