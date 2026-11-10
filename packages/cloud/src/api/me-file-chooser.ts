import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { FILE_CHOOSER_PLACE_MAX_BYTES, FileChooserPlaceBodySchema } from "../contracts/file-chooser-place";
import { type AuthContext, jsonResponse, requiresAuth, v } from "../server";
import { fileChooserPlaces } from "../services/file-chooser-place";

/** Mounted beneath /me's authentication and user-actor guards. */
export const createMeFileChooserRoutes = (service = fileChooserPlaces) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      if (!c.get("user")) return c.json({ message: "Authentication required" }, 401);
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/file-chooser/place",
      describeRoute({
        tags: ["Me"],
        summary: "Read where the file chooser opens",
        ...requiresAuth,
        responses: { 200: jsonResponse(FileChooserPlaceBodySchema, "The last place in the file chooser, or null for This device") },
      }),
      async (c) => c.json({ place: await service.get(c.get("user").id) }),
    )
    .put(
      "/file-chooser/place",
      describeRoute({
        tags: ["Me"],
        summary: "Remember where the file chooser opens",
        ...requiresAuth,
        responses: { 204: { description: "Remembered" } },
      }),
      bodyLimit({ maxSize: FILE_CHOOSER_PLACE_MAX_BYTES }),
      v("json", FileChooserPlaceBodySchema),
      async (c) => {
        await service.set(c.get("user").id, c.req.valid("json").place);
        return c.body(null, 204);
      },
    );
