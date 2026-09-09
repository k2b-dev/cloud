/**
 * app-files's own settings HTTP API. Owns reads/writes for files.* keys.
 *
 * Endpoints:
 *   PUT    /api/files/admin/settings           — bulk update, atomic
 *   DELETE /api/files/admin/settings/:key{.+}  — reset to default
 */
import { Hono } from "hono";
import { sql } from "bun";
import { z } from "zod";
import { app } from "../config";
import { auth, v, type AuthContext } from "@k2b/cloud/server";

// Source of truth for which keys app-files owns
const FILES_KEYS = new Set([
  "files.filegate_url",
  "files.filegate_token",
  "files.base_homes",
  "files.base_groups",
  "files.home_dir_mode",
  "files.home_file_mode",
  "files.group_dir_mode",
  "files.group_file_mode",
]);
const isFilesKey = (key: string): boolean => FILES_KEYS.has(key);

const BulkUpdateSchema = z.record(z.string(), z.unknown());

export const filesSettingsRouter = new Hono<AuthContext>()
  .put("/", auth.requireRole("admin"), v("json", BulkUpdateSchema), async (c) => {
    const updates = c.req.valid("json");
    const keys = Object.keys(updates);
    if (keys.length === 0) return c.body(null, 204);

    const ownership: Record<string, string> = {};
    for (const key of keys) {
      if (!isFilesKey(key)) ownership[key] = `Setting "${key}" is not owned by app-files`;
    }
    if (Object.keys(ownership).length > 0) {
      return c.json({ message: "Invalid keys", errors: ownership }, 400);
    }

    const fieldErrors: Record<string, string> = {};
    try {
      await sql.begin(async () => {
        for (const [key, value] of Object.entries(updates)) {
          try {
            await app.settings.set(key as never, value as never);
          } catch (error) {
            fieldErrors[key] = error instanceof Error ? error.message : `Failed to update ${key}`;
            throw error;
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      return c.json({ message, errors: Object.keys(fieldErrors).length > 0 ? fieldErrors : { _form: message } }, 400);
    }

    return c.body(null, 204);
  })
  .delete("/:key{.+}", auth.requireRole("admin"), async (c) => {
    const key = c.req.param("key");
    if (!isFilesKey(key)) {
      return c.json({ message: `Setting "${key}" is not owned by app-files` }, 400);
    }
    try {
      await app.settings.remove(key as never);
      return c.body(null, 204);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "Reset failed" }, 500);
    }
  });
