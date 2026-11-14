import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { ScreenPreferencesSchema } from "../contracts/screen-preferences";
import { type AuthContext, jsonResponse, requiresAuth, v } from "../server";
import { screenPreferences } from "../services/screen-preferences";

/** Mounted beneath /me's authentication and user-actor guards. */
export const createMeScreenRoutes = (service = screenPreferences) =>
  new Hono<AuthContext>()
    .use("/screen", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/screen",
      describeRoute({
        tags: ["Me"],
        summary: "Read personal screen preferences",
        description: "The privacy screen's timer in seconds; 0 means off.",
        ...requiresAuth,
        responses: { 200: jsonResponse(ScreenPreferencesSchema, "Personal screen preferences") },
      }),
      async (c) => c.json(await service.get(c.get("user").id)),
    )
    .put(
      "/screen",
      describeRoute({
        tags: ["Me"],
        summary: "Save personal screen preferences",
        description: "Saves the privacy screen's timer for every computer the person signs in on.",
        ...requiresAuth,
        responses: { 200: jsonResponse(ScreenPreferencesSchema, "Saved screen preferences") },
      }),
      v("json", ScreenPreferencesSchema),
      async (c) => c.json(await service.save(c.get("user").id, c.req.valid("json"))),
    );
