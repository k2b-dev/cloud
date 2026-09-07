/**
 * Admin API for platform-wide runtime settings.
 *
 * This route lives in cloud-lib because `/admin/settings` is a platform page
 * and needs a typed client without depending on the core app package. The
 * core app mounts it under `/api/admin/core/settings`.
 */
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { listApps } from "../_internal/registry";
import { listAiCredentialProfileIds, pruneAiCredentials, setAiCredential, splitAiProfileCredentials } from "../ai/credentials";
import { enrichDirtyAiConversations } from "../ai/enrich";
import { parseAiModelProfiles, planAiProfileCredentials, validateAiSettingsConfiguration } from "../ai/settings";
import { type AuthContext, auth, v } from "../server";
import { settingsDeleteLegacyKeys, settingsListLegacyKeys } from "../services";
import { validateFreeIpaCaCert } from "../services/freeipa-config";
import { testFreeIpaConnection } from "../services/ipa/connection";
import { sendEmail } from "../services/notifications/email";
import { GotenbergRenderError, testGotenberg } from "../services/pdf";
import * as settings from "../services/settings";
import { SETTINGS_MAP, validateSettingValue } from "../services/settings/defaults";

const BulkSaveSchema = z.union([
  z
    .object({
      updates: z.record(z.string(), z.unknown()).optional().default({}),
      resets: z.array(z.string()).optional().default([]),
    })
    .strict(),
  z.record(z.string(), z.unknown()).transform((updates) => ({ updates, resets: [] as string[] })),
]);
const TestEmailSchema = z.object({
  recipient: z.email(),
});

type FieldErrors = Record<string, string>;
const LEGAL_DOCUMENTS = [
  { kind: "terms", path: "/legal/terms" },
  { kind: "privacy", path: "/legal/privacy" },
  { kind: "imprint", path: "/impressum" },
] as const;


const isKnownSetting = (key: string): boolean => SETTINGS_MAP.has(key);

const AI_PROFILES_KEY = "ai.model_profiles_json";
const AI_ENABLED_KEY = "ai.enabled";
const AI_DEFAULT_MODEL_KEY = "ai.default_model_id";
const AI_BACKGROUND_MODEL_KEY = "ai.background_model_id";
const AI_VISION_MODEL_KEY = "ai.vision_model_id";
const AI_WORKFLOW_MODEL_KEY = "ai.workflow_model_id";
const AI_CONFIGURATION_KEYS = new Set([
  AI_ENABLED_KEY,
  AI_DEFAULT_MODEL_KEY,
  AI_BACKGROUND_MODEL_KEY,
  AI_VISION_MODEL_KEY,
  AI_WORKFLOW_MODEL_KEY,
  AI_PROFILES_KEY,
]);
const INTEGER_FREEIPA_SETTINGS = new Set(["freeipa.sync_guard.max_user_changes", "freeipa.sync_guard.max_group_deletions"]);

/**
 * Move provider keys out of the model-profiles value before it is stored.
 *
 * The admin form posts profiles as one value, and a newly typed key rides along
 * on its profile. Keys must not land in the setting — it is a `text` setting and
 * would be handed back to the browser in full — so they go to
 * `ai.model_credentials` here and are stripped from what gets saved. A profile
 * whose key field was left empty keeps whatever is already stored.
 *
 * Doing this in the route rather than the settings service keeps the generic
 * store free of AI knowledge, and keeps the admin page at a single save request.
 */
const storeAiCredentials = async (
  split: NonNullable<ReturnType<typeof splitAiProfileCredentials>>,
  keepCredentialProfileIds: readonly string[],
  db: typeof sql,
): Promise<void> => {
  for (const { profileId, secret } of split.credentials) await setAiCredential(profileId, secret, db);
  await pruneAiCredentials(keepCredentialProfileIds, db);
};

type AiSettingsMutationPlan = {
  errors: FieldErrors;
  keepCredentialProfileIds?: string[];
};

const valueAfterMutation = <T>(key: string, current: T, updates: Record<string, unknown>, resets: readonly string[]): T => {
  if (key in updates) return updates[key] as T;
  if (resets.includes(key)) return SETTINGS_MAP.get(key)?.default as T;
  return current;
};

const prepareAiSettingsMutation = async (
  updates: Record<string, unknown>,
  resets: readonly string[],
  aiSplit: ReturnType<typeof splitAiProfileCredentials>,
): Promise<AiSettingsMutationPlan> => {
  const keys = [...Object.keys(updates), ...resets];
  if (!keys.some((key) => AI_CONFIGURATION_KEYS.has(key))) return { errors: {} };

  const [currentEnabled, currentDefaultModelId, currentBackgroundModelId, currentVisionModelId, currentWorkflowModelId, currentProfilesJson] = await Promise.all([
    settings.get<boolean>(AI_ENABLED_KEY),
    settings.get<string>(AI_DEFAULT_MODEL_KEY),
    settings.get<string>(AI_BACKGROUND_MODEL_KEY),
    settings.get<string>(AI_VISION_MODEL_KEY),
    settings.get<string>(AI_WORKFLOW_MODEL_KEY),
    settings.get<string>(AI_PROFILES_KEY),
  ]);

  const currentParsed = parseAiModelProfiles(currentProfilesJson ?? "[]");
  const profilesUpdated = AI_PROFILES_KEY in updates;
  const profilesReset = resets.includes(AI_PROFILES_KEY);
  const nextParsed: ReturnType<typeof parseAiModelProfiles> = profilesUpdated
    ? parseAiModelProfiles(aiSplit?.profilesJson ?? "[]")
    : profilesReset
      ? { profiles: [] }
      : currentParsed;
  if (nextParsed.error) return { errors: nextParsed.error.fields ?? { [AI_PROFILES_KEY]: nextParsed.error.message } };

  const nextEnabled = Boolean(valueAfterMutation(AI_ENABLED_KEY, currentEnabled, updates, resets));
  const existingCredentialProfileIds = profilesUpdated || (!profilesReset && nextEnabled) ? await listAiCredentialProfileIds() : [];

  let keepCredentialProfileIds: string[] | undefined;
  if (profilesUpdated || profilesReset) {
    const credentialPlan = planAiProfileCredentials({
      currentProfiles: currentParsed.profiles,
      nextProfiles: nextParsed.profiles,
      existingCredentialProfileIds,
      submittedCredentialProfileIds: aiSplit?.credentials.map(({ profileId }) => profileId) ?? [],
    });
    if (credentialPlan.unsupportedCredentialProfileId) {
      return {
        errors: {
          [AI_PROFILES_KEY]: `Profile "${credentialPlan.unsupportedCredentialProfileId}" does not support provider credentials.`,
        },
      };
    }
    keepCredentialProfileIds = credentialPlan.keepCredentialProfileIds;
  }

  const errors = validateAiSettingsConfiguration({
    enabled: nextEnabled,
    defaultModelId: String(valueAfterMutation(AI_DEFAULT_MODEL_KEY, currentDefaultModelId ?? "", updates, resets)),
    backgroundModelId: String(valueAfterMutation(AI_BACKGROUND_MODEL_KEY, currentBackgroundModelId ?? "", updates, resets)),
    visionModelId: String(valueAfterMutation(AI_VISION_MODEL_KEY, currentVisionModelId ?? "", updates, resets)),
    workflowModelId: String(valueAfterMutation(AI_WORKFLOW_MODEL_KEY, currentWorkflowModelId ?? "", updates, resets)),
    profiles: nextParsed.profiles,
    credentialProfileIds: keepCredentialProfileIds ?? existingCredentialProfileIds,
  });
  return { errors, keepCredentialProfileIds };
};

const invalidateCommittedSettings = async (keys: readonly string[]): Promise<void> => {
  try {
    await settings.invalidateSettingsCache(keys);
  } catch (error) {
    console.error("[settings] committed values but failed to invalidate the shared cache; TTL recovery remains active", error);
  }
};
const liveSettingKeys = async () => (await listApps()).flatMap((app) => [...(app.settingKeys ?? [])]);

const app = new Hono<AuthContext>()
  .get("/legacy", auth.requireRole("admin"), async (c) => {
    return c.json(await settingsListLegacyKeys(await liveSettingKeys()));
  })
  .delete("/legacy", auth.requireRole("admin"), async (c) => {
    return c.json(await settingsDeleteLegacyKeys(await liveSettingKeys()));
  })
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
  .post("/test-email", auth.requireRole("admin"), v("json", TestEmailSchema), async (c) => {
    const { recipient } = c.req.valid("json");
    const sentAt = new Date().toISOString();

    try {
      await sendEmail(recipient, "Cloud test email", {
        rawHtml: `
          <p>This is a test email from Cloud.</p>
          <p>If you received this message, SMTP delivery is configured correctly.</p>
          <p style="margin-top:24px;color:#71717a;font-size:12px;">Sent at ${sentAt}</p>
        `,
      });
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send test email";
      return c.json({ message }, 500);
    }
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
        return c.json({ message: error.message, code: error.code, status: error.status }, error.code === "not_configured" ? 400 : 502);
      }
      return c.json({ message: "Failed to test Gotenberg PDF rendering" }, 500);
    }
  })
  .post("/test-freeipa", auth.requireRole("admin"), async (c) => {
    const result = await testFreeIpaConnection();
    if (result.ok) return c.json({ ok: true });
    return c.json({ message: result.error, kind: result.kind }, result.status);
  })
  .put("/", auth.requireRole("admin"), v("json", BulkSaveSchema), async (c) => {
    const { updates, resets } = c.req.valid("json");
    const updateKeys = Object.keys(updates);
    const keys = [...updateKeys, ...resets];

    if (keys.length === 0) {
      return c.body(null, 204);
    }

    const ownership: FieldErrors = {};
    for (const key of keys) {
      if (!isKnownSetting(key)) {
        ownership[key] = `Unknown setting "${key}"`;
      }
    }
    for (const key of resets) {
      if (key in updates) {
        ownership[key] = `Setting "${key}" cannot be updated and reset in the same save`;
      }
    }
    if (Object.keys(ownership).length > 0) {
      return c.json({ message: "Invalid keys", errors: ownership }, 400);
    }

    // Strip AI provider keys before anything is validated or written, so the
    // value that gets checked is the value that gets stored.
    const aiSplit = AI_PROFILES_KEY in updates ? splitAiProfileCredentials(updates[AI_PROFILES_KEY]) : null;
    if (AI_PROFILES_KEY in updates && !aiSplit) {
      // Unsplittable means the keys could not be separated out, and storing the
      // value as posted would put them back in a setting the browser reads.
      return c.json({ message: "Invalid values", errors: { [AI_PROFILES_KEY]: "Model profiles must be a JSON array" } }, 400);
    }
    const finalValues: Record<string, unknown> = aiSplit ? { ...updates, [AI_PROFILES_KEY]: aiSplit.profilesJson } : updates;

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

    let aiPlan: AiSettingsMutationPlan;
    try {
      aiPlan = await prepareAiSettingsMutation(validatedValues, resets, aiSplit);
    } catch (error) {
      console.error("[settings] failed to validate the prospective AI configuration", error);
      return c.json({ message: "Failed to validate AI settings" }, 500);
    }
    if (Object.keys(aiPlan.errors).length > 0) {
      return c.json({ message: "Invalid AI configuration", errors: aiPlan.errors }, 400);
    }

    const fieldErrors: FieldErrors = {};
    try {
      // Every settings and AI credential write runs on the transaction's own
      // connection, so a failure rolls the whole save back.
      await sql.begin(async (tx) => {
        for (const [key, value] of Object.entries(validatedValues)) {
          try {
            await settings.set(key, value, tx);
          } catch (error) {
            fieldErrors[key] = `Failed to update ${key}`;
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
        if (aiSplit && aiPlan.keepCredentialProfileIds) {
          await storeAiCredentials(aiSplit, aiPlan.keepCredentialProfileIds, tx);
        } else if (aiPlan.keepCredentialProfileIds) {
          await pruneAiCredentials(aiPlan.keepCredentialProfileIds, tx);
        }
      });
    } catch (error) {
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
  })
  .delete("/:key{.+}", auth.requireRole("admin"), async (c) => {
    const key = c.req.param("key");
    if (!isKnownSetting(key)) {
      return c.json({ message: `Unknown setting "${key}"` }, 400);
    }

    let aiPlan: AiSettingsMutationPlan;
    try {
      aiPlan = await prepareAiSettingsMutation({}, [key], null);
    } catch (error) {
      console.error("[settings] failed to validate the prospective AI configuration", error);
      return c.json({ message: "Failed to validate AI settings" }, 500);
    }
    if (Object.keys(aiPlan.errors).length > 0) {
      return c.json({ message: "Invalid AI configuration", errors: aiPlan.errors }, 400);
    }

    try {
      await sql.begin(async (tx) => {
        await settings.remove(key, tx);
        if (aiPlan.keepCredentialProfileIds) await pruneAiCredentials(aiPlan.keepCredentialProfileIds, tx);
      });
    } catch (error) {
      console.error(`[settings] failed to reset "${key}"`, error);
      return c.json({ message: "Reset failed" }, 500);
    }
    await invalidateCommittedSettings([key]);
    return c.body(null, 204);
  });

export default app;
export type ApiType = typeof app;
