/**
 * app-weather's own settings HTTP API. Owns reads/writes for weather.* keys.
 *
 *   PUT    /api/weather/admin/settings           — bulk update, unreadable keys refused before any write
 *   DELETE /api/weather/admin/settings/:key{.+}  — reset to default
 *
 * No special side-effect on save — weather queries on demand and picks up
 * fresh values via the per-request snapshot or async coreSettings reads.
 */

import { type AuthContext, auth, getLocale, v } from "@k2b/cloud/server";
import { SettingUnreadableError } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { app } from "../config";
import { weatherMessages } from "../messages";

const WEATHER_KEYS = new Set(["weather.default_lat", "weather.default_lon", "weather.cache_minutes"]);
const isWeatherKey = (key: string): key is Parameters<typeof app.settings.read>[0] => WEATHER_KEYS.has(key);

const BulkUpdateSchema = z.union([
  z.object({ updates: z.record(z.string(), z.unknown()), replaceUnreadable: z.array(z.string()) }).strict(),
  z.record(z.string(), z.unknown()).transform((updates) => ({ updates, replaceUnreadable: [] as string[] })),
]);

export const weatherSettingsRouter = new Hono<AuthContext>()
  .put("/", auth.requireRole("admin"), v("json", BulkUpdateSchema), async (c) => {
    const { t } = weatherMessages.resolve([getLocale(c)]);
    const { updates, replaceUnreadable } = c.req.valid("json");
    const replace = new Set(replaceUnreadable);
    const keys = Object.keys(updates);
    if (keys.length === 0 && replace.size === 0) return c.body(null, 204);

    const ownership = new Map<string, string>();
    for (const key of keys) {
      if (!isWeatherKey(key)) ownership.set(key, t.settingNotOwned({ key }));
    }
    for (const key of replace) {
      if (!isWeatherKey(key)) ownership.set(key, t.settingNotOwned({ key }));
      else if (!Object.hasOwn(updates, key)) ownership.set(key, t.invalidKeys);
    }
    if (ownership.size > 0) {
      return c.json({ message: t.invalidKeys, errors: Object.fromEntries(ownership) }, 400);
    }

    const fieldErrors: Record<string, string> = {};
    try {
      for (const key of keys.filter(isWeatherKey)) {
        if (!replace.has(key) && (await app.settings.read(key)).stored === "unreadable") throw new SettingUnreadableError(key);
      }
      await sql.begin(async () => {
        for (const [key, value] of Object.entries(updates)) {
          try {
            await app.settings.set(key as never, value as never, { replaceUnreadable: replace.has(key) });
          } catch (error) {
            fieldErrors[key] = t.updateSettingFailed({ key });
            throw error;
          }
        }
      });
    } catch (error) {
      if (error instanceof SettingUnreadableError) throw error;
      const message = Object.values(fieldErrors)[0] ?? t.saveFailed;
      return c.json({ message, errors: Object.keys(fieldErrors).length > 0 ? fieldErrors : { _form: message } }, 400);
    }

    return c.body(null, 204);
  })
  .delete("/:key{.+}", auth.requireRole("admin"), async (c) => {
    const { t } = weatherMessages.resolve([getLocale(c)]);
    const key = c.req.param("key");
    if (!isWeatherKey(key)) {
      return c.json({ message: t.settingNotOwned({ key }) }, 400);
    }
    try {
      await app.settings.remove(key as never);
      return c.body(null, 204);
    } catch {
      return c.json({ message: t.resetFailed }, 500);
    }
  });
