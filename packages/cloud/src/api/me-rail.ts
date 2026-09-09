import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { RAIL_PREFERENCES_MAX_BYTES, RailPreferencesSchema } from "../contracts/rail-preferences";
import { type AuthContext, jsonResponse, requiresAuth, v } from "../server";
import { railPreferences } from "../services/rail-preferences";

/** Mounted beneath /me's authentication and user-actor guards. */
export const createMeRailRoutes = (service = railPreferences) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      if (!c.get("user")) return c.json({ message: "Authentication required" }, 401);
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/rail",
      describeRoute({
        tags: ["Me"],
        summary: "Read personal app bar settings",
        ...requiresAuth,
        responses: { 200: jsonResponse(RailPreferencesSchema, "Personal app bar settings") },
      }),
      async (c) => c.json(await service.get(c.get("user").id)),
    )
    .put(
      "/rail",
      describeRoute({
        tags: ["Me"],
        summary: "Save personal app bar settings",
        ...requiresAuth,
        responses: {
          200: jsonResponse(RailPreferencesSchema, "Saved app bar settings"),
          409: { description: "Settings changed since they were read" },
        },
      }),
      bodyLimit({ maxSize: RAIL_PREFERENCES_MAX_BYTES }),
      v("json", RailPreferencesSchema),
      async (c) => {
        const saved = await service.save(c.get("user").id, c.req.valid("json"));
        return saved
          ? c.json(saved)
          : c.json({ code: "CONFLICT", message: "App bar settings changed. Reopen the editor before saving again." }, 409);
      },
    );
