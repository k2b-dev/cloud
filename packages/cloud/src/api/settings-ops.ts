import { Hono } from "hono";
import { z } from "zod";
// Concrete modules, not the server barrel: defineApp imports this file, and the barrel imports defineApp.
import { type AuthContext, auth } from "../server/middleware/auth";
import { v } from "../server/middleware/validator";
import { settingsService } from "../services/settings/app";
import { SETTINGS_MAP } from "../services/settings/defaults";
import { readEnvSettingsStatus } from "../services/settings/env-status";

export const settingsInvocationOperation = (method: string, key: string) => {
  try {
    return `settings.${method === "GET" ? "env" : "set"}:${decodeURIComponent(key)}`;
  } catch {
    return "settings.invalid";
  }
};

export const createSettingsOpsRoutes = (keys: readonly string[]) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      if (!c.get("user")?.roles.includes("admin")) return c.json({ message: "Insufficient permissions" }, 403);
      return next();
    })
    .use("*", auth.requireOAuthScope("admin"))
    .get("/env", async (c) => c.json({ settings: await readEnvSettingsStatus() }, 200, { "cache-control": "no-store" }))
    .put("/:key", v("json", z.object({ value: z.unknown(), replaceUnreadable: z.boolean().optional() })), async (c) => {
      const key = c.req.param("key") ?? "";
      const def = SETTINGS_MAP.get(key);
      if (!keys.includes(key) || !def || !(def.envBootstrap || def.envFallback))
        return c.json({ message: "Unknown application setting" }, 400);
      const body = c.req.valid("json");
      const result = await settingsService.entry.update({ key, value: body.value, replaceUnreadable: body.replaceUnreadable });
      if (!result.ok) return c.json({ message: result.error.message }, 400);
      return c.json({ saved: true });
    });
