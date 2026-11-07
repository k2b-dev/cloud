import { type AuthContext, auth, expectUserBackedActor, getLocale, jsonResponse, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { settingsService } from "@k2b/cloud/services";
import { err, fail, i18n } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { unknownSetting: "Unknown Tools setting." },
    de: { unknownSetting: "Unbekannte Werkzeuge-Einstellung." },
  },
});
const ErrorSchema = z.object({ code: z.string().optional(), message: z.string() });

export default new Hono<AuthContext>().put(
  "/:key",
  auth.requireRole("admin"),
  describeRoute({
    tags: ["Tools Admin"],
    summary: "Update a Tools administrator setting",
    ...requiresAdmin,
    responses: {
      200: { description: "Setting updated" },
      400: jsonResponse(ErrorSchema, "Invalid setting or value"),
      403: jsonResponse(ErrorSchema, "Cloud administrator required"),
      409: jsonResponse(ErrorSchema, "Stored setting unreadable; explicit replacement required"),
    },
  }),
  v("json", z.object({ value: z.unknown(), replaceUnreadable: z.boolean().optional() })),
  async (c) => {
    const key = c.req.param("key") ?? "";
    if (!key.startsWith("tools.")) return respond(c, fail(err.badInput(messages.resolve([getLocale(c)]).t.unknownSetting)));
    return respond(
      c,
      await settingsService.entry.update({
        key,
        ...c.req.valid("json"),
        audit: {
          action: "settings.update",
          outcome: "allowed",
          actor: { userId: expectUserBackedActor(c).id },
          target: { type: "setting", id: key },
        },
      }),
    );
  },
);
