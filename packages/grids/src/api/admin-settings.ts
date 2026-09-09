import { err, fail, ok } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { settingsService } from "@k2b/cloud/services";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { apiMessages } from "./messages";
import { v } from "./validator";

const GRIDS_SETTING_GROUP = "grids";
const GRIDS_SETTING_PREFIX = "grids.";

const SettingEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.string(),
  description: z.string(),
  default: z.unknown(),
  value: z.unknown(),
  isCustom: z.boolean(),
});

const UpdateSettingSchema = z.object({
  value: z.unknown(),
});

const app = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))

  .get(
    "/",
    describeRoute({
      tags: ["Grids:Admin"],
      summary: "List Grids app settings",
      responses: {
        200: jsonResponse(z.array(SettingEntrySchema), "Grids settings"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    async (c) => {
      const result = await settingsService.entry.list({ filter: { group: GRIDS_SETTING_GROUP }, locale: getLocale(c) });
      return respond(c, ok(result.items));
    },
  )

  .put(
    "/:key{.+}",
    describeRoute({
      tags: ["Grids:Admin"],
      summary: "Update a Grids app setting",
      responses: {
        200: jsonResponse(z.object({ message: z.string() }), "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid key or value"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", UpdateSettingSchema),
    async (c) => {
      const key = c.req.param("key") ?? "";
      if (!key.startsWith(GRIDS_SETTING_PREFIX)) {
        return respond(c, fail(err.badInput(`Setting "${key}" is not in the grids namespace`)));
      }
      const result = await settingsService.entry.update({ key, value: c.req.valid("json").value });
      if (!result.ok) return respond(c, result);
      return respond(c, ok({ message: apiMessages(c).settingUpdated }));
    },
  );

export default app;
