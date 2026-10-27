/**
 * Admin API for platform-wide runtime settings.
 *
 * This route lives in cloud-lib because `/admin/settings` is a platform page
 * and needs a typed client without depending on the core app package. The
 * core app mounts it under `/api/admin/core/settings`.
 */

import { sql } from "bun";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { listApps } from "../_internal/registry";
import { enrichDirtyAiConversations } from "../ai/enrich";
import { type AuthContext, auth, getLocale, jsonResponse, requiresAdmin, v } from "../server";
import { settingsDeleteLegacyKeys, settingsListLegacyKeys } from "../services";
import { readAccountCategoryPolicy } from "../services/account-category-policy";
import { audit } from "../services/audit";
import { ConfigConflict } from "../services/config-conflict";
import { validateFreeIpaCaCert } from "../services/freeipa-config";
import { ImageMetadataError } from "../services/image-metadata";
import { testFreeIpaConnection } from "../services/ipa/connection";
import { GotenbergRenderError, testGotenberg } from "../services/pdf";
import * as settings from "../services/settings";
import { SETTINGS_MAP, validateSettingValue } from "../services/settings/defaults";
import { assertGeoBudgetPair, GeoBudgetSettingError } from "../services/settings/geo-budget";
import { invalidateSettingsCacheForAdmin } from "../services/settings/store";
import { assertSettingVersions } from "../services/settings/versions";

const BulkUpdatesSchema = z
  .object({
    updates: z.record(z.string(), z.unknown()).optional().default({}),
    resets: z.array(z.string()).optional().default([]),
    replaceUnreadable: z.array(z.string()).optional().default([]),
    expectedUpdatedAt: z.record(z.string(), z.string().nullable()).optional().default({}),
  })
  .strict();
const BulkSaveSchema = z.union([
  BulkUpdatesSchema,
  z.record(z.string(), z.unknown()).transform((updates) => BulkUpdatesSchema.parse({ updates })),
]);
const LEGAL_DOCUMENTS = [
  { kind: "terms", path: "/legal/terms" },
  { kind: "privacy", path: "/legal/privacy" },
  { kind: "imprint", path: "/impressum" },
] as const;

type FieldErrors = Record<string, string>;

const unreadableSettingMessage = (locale: string): string =>
  locale.startsWith("de")
    ? "Der gespeicherte Wert kann von dieser Anwendung nicht gelesen werden. Ersetze ihn ausdrücklich oder nutze den Standardwert."
    : "The stored value cannot be read by this application. Replace it explicitly or use the default.";
const settingsNotSavedMessage = (locale: string): string =>
  locale.startsWith("de") ? "Die Einstellungen wurden nicht gespeichert." : "The settings were not saved.";

const isKnownSetting = (key: string): boolean => SETTINGS_MAP.has(key);
// The Geoapify key is written only where Cloud verifies it with the provider first, so a refused key never replaces a working one.
const GEO_KEY = "geo.api_key";
const GEO_KEY_DEDICATED = "Set or remove the Geoapify key with /api/admin/core/geo/key, which verifies it first.";

const INTEGER_FREEIPA_SETTINGS = new Set(["freeipa.sync_guard.max_user_changes", "freeipa.sync_guard.max_group_deletions"]);

const invalidateCommittedSettings = async (keys: readonly string[]): Promise<void> => {
  try {
    await settings.invalidateSettingsCache(keys);
  } catch (error) {
    console.error("[settings] committed values but failed to invalidate the shared cache; TTL recovery remains active", error);
  }
};
const liveSettingKeys = async () => (await listApps()).flatMap((app) => [...(app.settingKeys ?? [])]);

const app = new Hono<AuthContext>()
  .get("/web-vitals", auth.requireRole("admin"), async (c) =>
    c.json({ enabled: (await settings.get("observability.web_vitals.enabled")) === true }),
  )
  .delete(
    "/cache",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Administration"],
      summary: "Invalidate registered settings cache",
      ...requiresAdmin,
      responses: { 200: jsonResponse(z.object({ success: z.literal(true) }), "Cache invalidated") },
    }),
    async (c) => {
      await invalidateSettingsCacheForAdmin(c.get("user"), await liveSettingKeys());
      c.header("Cache-Control", "no-store");
      return c.json({ success: true as const });
    },
  )
  .get(
    "/documentation",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Administration"],
      summary: "Read the documentation website configuration",
      ...requiresAdmin,
      responses: { 200: jsonResponse(z.object({ url: z.string() }), "Documentation base URL") },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ url: await settings.get<string>("app.documentation_url") });
    },
  )
  .get(
    "/app-sign-in",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Administration"],
      summary: "Read app sign-in configuration",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ enabled: z.boolean(), origin: z.string(), adminPairing: z.boolean() }), "App sign-in configuration"),
      },
    }),
    async (c) =>
      c.json({
        enabled: await settings.get<boolean>("user.app_approval.enabled"),
        origin: await settings.get<string>("user.app_approval.origin"),
        adminPairing: await settings.get<boolean>("user.app_approval.admin_pairing"),
      }),
  )
  .get("/account-categories", auth.requireRole("admin"), async (c) => c.json(await readAccountCategoryPolicy()))
  .get(
    "/account-administration",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Administration"],
      summary: "Read account-request policy and follow-up notice configuration",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ requestsEnabled: z.boolean(), actionNotice: z.string() }), "Current account administration options"),
      },
    }),
    async (c) => {
      const [requestsEnabled, actionNotice] = await Promise.all([
        settings.get<boolean>("user.account_requests.enabled"),
        settings.get<string>("user.action_notice"),
      ]);
      c.header("Cache-Control", "no-store");
      return c.json({ requestsEnabled, actionNotice });
    },
  )
  .get("/legal", auth.requireRole("admin"), async (c) => {
    const items = await Promise.all(
      LEGAL_DOCUMENTS.map(async ({ kind, path }) => {
        const [rawMode, content, url] = await Promise.all([
          settings.get<string>(`legal.${kind}.mode`),
          settings.get<string>(`legal.${kind}.content`),
          settings.get<string>(`legal.${kind}.url`),
        ]);
        return {
          kind,
          path,
          mode: rawMode === "external" ? "external" : "local",
          content: content ?? "",
          url: url ?? "",
        };
      }),
    );
    return c.json({ items });
  })
  .get("/legacy", auth.requireRole("admin"), async (c) => {
    return c.json(await settingsListLegacyKeys(await liveSettingKeys()));
  })
  .delete("/legacy", auth.requireRole("admin"), async (c) => {
    return c.json(await settingsDeleteLegacyKeys(await liveSettingKeys()));
  })
  .post("/run-ai-enrichment", auth.requireRole("admin"), async (c) => {
    try {
      // Small manual batch — the cron handles bulk; this is "kick it now".
      const summary = await enrichDirtyAiConversations({ limit: 25 });
      return c.json({ ok: true, summary });
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "AI enrichment run failed" }, 500);
    }
  })
  .post("/test-pdf", auth.requireRole("admin"), async (c) => {
    try {
      const result = await testGotenberg();
      return c.json({ ok: true, bytes: result.bytes, contentType: result.contentType });
    } catch (error) {
      if (error instanceof GotenbergRenderError) {
        return c.json(
          { message: error.message, code: error.code, status: error.status },
          error.code === "busy" ? 503 : error.code === "not_configured" ? 400 : 502,
        );
      }
      return c.json({ message: "Failed to test Gotenberg PDF rendering" }, 500);
    }
  })
  .post("/test-freeipa", auth.requireRole("admin"), async (c) => {
    const result = await testFreeIpaConnection();
    if (result.ok) return c.json({ ok: true });
    return c.json({ message: result.error, kind: result.kind }, result.status);
  })
  .put(
    "/",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Administration"],
      summary: "Save platform settings",
      ...requiresAdmin,
      responses: {
        204: { description: "Settings saved" },
        400: jsonResponse(z.object({ message: z.string(), errors: z.record(z.string(), z.string()).optional() }), "Invalid settings"),
        409: jsonResponse(
          z.object({ message: z.string(), errors: z.record(z.string(), z.string()), code: z.literal("setting_unreadable").optional() }),
          "Stored setting unreadable or model access conflict",
        ),
      },
    }),
    v("json", BulkSaveSchema),
    async (c) => {
      const { updates, resets, replaceUnreadable, expectedUpdatedAt } = c.req.valid("json");
      const replace = new Set(replaceUnreadable);
      const updateKeys = Object.keys(updates);
      const keys = [...updateKeys, ...resets];

      if (keys.length === 0 && replace.size === 0 && Object.keys(expectedUpdatedAt).length === 0) {
        return c.body(null, 204);
      }

      const ownership: FieldErrors = {};
      for (const key of keys) {
        if (!isKnownSetting(key)) {
          ownership[key] = `Unknown setting "${key}"`;
        }
      }
      for (const key of Object.keys(expectedUpdatedAt)) {
        if (!keys.includes(key)) ownership[key] = `Setting "${key}" must be included in updates or resets`;
      }
      for (const key of replace) {
        if (!Object.hasOwn(updates, key)) ownership[key] = `Setting "${key}" must be included in updates to replace its unreadable value`;
      }
      for (const key of resets) {
        if (key in updates) {
          ownership[key] = `Setting "${key}" cannot be updated and reset in the same save`;
        }
      }
      if (keys.includes(GEO_KEY)) ownership[GEO_KEY] = GEO_KEY_DEDICATED;
      if (Object.keys(ownership).length > 0) {
        return c.json({ message: "Invalid keys", errors: ownership }, 400);
      }

      const states = await settings.readStates(updateKeys);
      const unreadable: FieldErrors = {};
      for (const key of updateKeys) {
        if (states.get(key)?.stored === "unreadable" && !replace.has(key)) unreadable[key] = unreadableSettingMessage(getLocale(c));
      }
      if (Object.keys(unreadable).length > 0) {
        return c.json({ message: settingsNotSavedMessage(getLocale(c)), errors: unreadable, code: "setting_unreadable" }, 409);
      }

      const finalValues = updates;

      // Validate everything up front. settings.set validates as it writes, so a
      // single bad field used to leave the earlier keys already saved — with the
      // AI profiles among them, whose save also prunes credentials.
      const invalid: FieldErrors = {};
      const validatedValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(finalValues)) {
        const def = SETTINGS_MAP.get(key);
        if (!def) continue;
        const validated = validateSettingValue(def, value);
        if (validated.ok) validatedValues[key] = validated.value;
        else invalid[key] = validated.error;
        if (key === "freeipa.ca_cert") {
          const certificate = validateFreeIpaCaCert(value);
          if (!certificate.ok) invalid[key] = certificate.error;
        }
        if (INTEGER_FREEIPA_SETTINGS.has(key) && (typeof value !== "number" || !Number.isInteger(value))) {
          invalid[key] = "Value must be a whole number";
        }
      }
      if (Object.keys(invalid).length > 0) {
        return c.json({ message: "Invalid values", errors: invalid }, 400);
      }

      const fieldErrors: FieldErrors = {};
      try {
        // Every settings and AI credential write runs on the transaction's own
        // connection, so a failure rolls the whole save back.
        await sql.begin(async (tx) => {
          await assertSettingVersions(expectedUpdatedAt, tx);
          await assertGeoBudgetPair(tx, validatedValues, resets);
          for (const [key, value] of Object.entries(validatedValues)) {
            try {
              await settings.set(key, value, tx, { replaceUnreadable: replace.has(key) });
              await tx`UPDATE settings.entries SET updated_by=${c.get("user").id}::uuid WHERE key=${key}`;
            } catch (error) {
              fieldErrors[key] = `Failed to save ${key}`;
              throw error;
            }
          }
          for (const key of resets) {
            try {
              await settings.remove(key, tx);
            } catch (error) {
              fieldErrors[key] = `Failed to reset ${key}`;
              throw error;
            }
          }
          const categoryKeys = keys.filter((key) => key.startsWith("user.category."));
          if (categoryKeys.length > 0)
            await audit.record(
              {
                action: "accounts.categories.configure",
                outcome: "allowed",
                actor: { userId: c.get("user").id },
                target: { type: "settings", id: "user.category" },
                metadata: {
                  keys: categoryKeys,
                  updates: Object.fromEntries(
                    categoryKeys.filter((key) => key in validatedValues).map((key) => [key, validatedValues[key]]),
                  ),
                  resets: resets.filter((key) => categoryKeys.includes(key)),
                },
              },
              tx,
            );
        });
      } catch (error) {
        if (error instanceof GeoBudgetSettingError) return error.getResponse();
        if (error instanceof settings.SettingUnreadableError) {
          return c.json(
            {
              message: settingsNotSavedMessage(getLocale(c)),
              errors: { [error.key]: unreadableSettingMessage(getLocale(c)) },
              code: "setting_unreadable",
            },
            409,
          );
        }
        if (error instanceof ImageMetadataError) return c.json({ message: error.message, code: error.code, errors: fieldErrors }, 422);
        if (error instanceof ConfigConflict)
          return c.json(
            { code: error.code, current: error.current, key: error.key, changedBy: error.changedBy, changedAt: error.changedAt },
            409,
          );
        console.error("[settings] failed to commit settings update", error);
        return c.json(
          {
            message: "Save failed",
            errors: Object.keys(fieldErrors).length > 0 ? fieldErrors : { _form: "The settings could not be saved." },
          },
          500,
        );
      }

      // Only now: dropping the cache before the commit would let another
      // container miss, read the pre-commit row and cache it for the full TTL.
      await invalidateCommittedSettings(keys);

      return c.body(null, 204);
    },
  )
  .delete("/:key{.+}", auth.requireRole("admin"), async (c) => {
    const key = c.req.param("key");
    if (!isKnownSetting(key)) {
      return c.json({ message: `Unknown setting "${key}"` }, 400);
    }
    if (key === GEO_KEY) return c.json({ message: GEO_KEY_DEDICATED, errors: { [GEO_KEY]: GEO_KEY_DEDICATED } }, 400);

    try {
      await sql.begin(async (tx) => {
        await assertGeoBudgetPair(tx, {}, [key]);
        await settings.remove(key, tx);
        if (key.startsWith("user.category."))
          await audit.record(
            {
              action: "accounts.categories.configure",
              outcome: "allowed",
              actor: { userId: c.get("user").id },
              target: { type: "setting", id: key },
              metadata: { reset: true },
            },
            tx,
          );
      });
    } catch (error) {
      if (error instanceof GeoBudgetSettingError || error instanceof settings.SettingUnreadableError) return error.getResponse();
      console.error(`[settings] failed to reset "${key}"`, error);
      return c.json({ message: "Reset failed" }, 500);
    }
    await invalidateCommittedSettings([key]);
    return c.body(null, 204);
  });

export default app;
export type ApiType = typeof app;
