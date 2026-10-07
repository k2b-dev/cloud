import { sql } from "bun";
import { coreSettings } from "../services";
import { audit } from "../services/audit";
import { invalidateSettingsCache, set as setSetting } from "../services/settings";
import { decryptValue } from "../services/settings/crypto";
import {
  type AiModelRequestSettings,
  type AiModelRequestSettingsUpdate,
  AiModelRequestSettingsUpdateSchema,
} from "../shared/ai-model-request-settings";
import { AiQuotaError } from "./quotas";
import { getAiRequestHeaders, planAiProfileRequestHeaders, storeAiRequestHeaderPlan } from "./request-headers";
import { parseAiModelProfiles } from "./settings";
import type { AiModelProfile } from "./types";

const key = "ai.model_profiles_json";
export class AiModelRequestSettingsInvalid extends Error {}

const readSnapshot = async (id: string, fallback: string, db: typeof sql, lock = false) => {
  const rows = lock
    ? await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key} FOR UPDATE`
    : await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key}`;
  const raw = rows[0] ? await decryptValue(rows[0].value) : fallback;
  if (typeof raw !== "string") throw new AiModelRequestSettingsInvalid("Invalid model configuration.");
  const parsed = parseAiModelProfiles(raw);
  if (parsed.error) throw new AiModelRequestSettingsInvalid(parsed.error.fields?.[key] ?? parsed.error.message);
  const profile = parsed.profiles.find((profile) => profile.id === id);
  if (!profile) throw new AiQuotaError("quota_conflict", "Model no longer exists.");
  const [headerRow] = await db<{ secret: string }[]>`SELECT secret FROM ai.model_request_headers WHERE profile_id=${id}`;
  // Hash ciphertext, never secret values. Any settings/header change invalidates
  // the snapshot, including replacement of a value under an unchanged name.
  const revision = new Bun.CryptoHasher("sha256").update(JSON.stringify([rows[0]?.value ?? raw, headerRow?.secret ?? null])).digest("hex");
  const requestHeaderNames = Object.keys(await getAiRequestHeaders(id, db)).sort();
  return { profiles: parsed.profiles, profile, settings: present(profile, requestHeaderNames, revision) };
};
const present = (profile: AiModelProfile, requestHeaderNames: string[], revision: string): AiModelRequestSettings => ({
  id: profile.id,
  reasoningEffort: profile.reasoningEffort ?? null,
  extraBody: profile.extraBody ?? null,
  requestHeaderNames,
  revision,
});

export const getAiModelRequestSettings = async (id: string): Promise<AiModelRequestSettings> =>
  (await readSnapshot(id, await coreSettings.get<string>(key), sql)).settings;

/** One transaction changes the non-secret profile and encrypted headers; audit contains names only. */
export const setAiModelRequestSettings = async (
  id: string,
  input: AiModelRequestSettingsUpdate,
  actorId: string,
): Promise<AiModelRequestSettings> => {
  const data = AiModelRequestSettingsUpdateSchema.parse(input);
  const fallback = await coreSettings.get<string>(key);
  const result = await sql.begin(async (db) => {
    const current = await readSnapshot(id, fallback, db, true);
    if (current.settings.revision !== data.expected)
      throw new AiQuotaError("quota_conflict", "Model request settings changed. Read them again before updating.");
    const nextProfile = { ...current.profile };
    if (Object.hasOwn(data, "reasoningEffort")) {
      if (data.reasoningEffort) nextProfile.reasoningEffort = data.reasoningEffort;
      else delete nextProfile.reasoningEffort;
    }
    if (Object.hasOwn(data, "extraBody")) {
      if (data.extraBody) nextProfile.extraBody = data.extraBody;
      else delete nextProfile.extraBody;
    }
    const validated = parseAiModelProfiles(JSON.stringify([nextProfile]));
    if (validated.error) throw new AiModelRequestSettingsInvalid(validated.error.fields?.[key] ?? validated.error.message);
    const headers = data.clearRequestHeaders ? {} : await getAiRequestHeaders(id, db);
    const plan = planAiProfileRequestHeaders({
      currentProfiles: [current.profile],
      nextProfiles: [nextProfile],
      existingNames: { [id]: Object.keys(headers) },
      submitted: data.requestHeaders === undefined ? [] : [{ profileId: id, patch: data.requestHeaders }],
    });
    if (plan.error) throw new AiModelRequestSettingsInvalid(plan.error);
    // This endpoint owns one profile only. Never prune the other profiles.
    const keepOthers = current.profiles.filter((profile) => profile.id !== id).map((profile) => profile.id);
    plan.keepHeaderProfileIds = [...keepOthers, ...(data.clearRequestHeaders ? [] : plan.keepHeaderProfileIds)];
    await storeAiRequestHeaderPlan(plan, db);
    await setSetting(key, JSON.stringify(current.profiles.map((profile) => (profile.id === id ? validated.profiles[0] : profile))), db);
    const saved = (await readSnapshot(id, fallback, db)).settings;
    await audit.record(
      {
        action: "ai.model.request-settings",
        outcome: "allowed",
        actor: { userId: actorId },
        target: { type: "ai-model", id },
        metadata: { reasoningEffort: saved.reasoningEffort, extraBody: saved.extraBody, requestHeaderNames: saved.requestHeaderNames },
      },
      db,
    );
    return saved;
  });
  await invalidateSettingsCache([key]);
  return result;
};
