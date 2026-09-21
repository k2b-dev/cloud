import { sql } from "bun";
import { coreSettings } from "../services";
import { audit } from "../services/audit";
import { invalidateSettingsCache, set as setSetting } from "../services/settings";
import { decryptValue } from "../services/settings/crypto";
import { type AiModelPricing, AiModelPricingSchema } from "../shared/ai-costs";
import { AiQuotaError } from "./quotas";
import { parseAiModelProfiles } from "./settings";

/** Change prices only, preserving credentials and model access in their own stores. */
export async function setAiModelPricing(id: string, pricing: AiModelPricing | null, expected: AiModelPricing | null, actorId: string) {
  if (pricing) AiModelPricingSchema.parse(pricing);
  const key = "ai.model_profiles_json";
  const fallback = await coreSettings.get<string>(key);
  const result = await sql.begin(async (db) => {
    const [row] = await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key} FOR UPDATE`;
    const raw = row ? await decryptValue(row.value) : fallback;
    if (typeof raw !== "string") throw new Error("Invalid model configuration.");
    const parsed = parseAiModelProfiles(raw);
    if (parsed.error) throw new Error(parsed.error.message);
    const profile = parsed.profiles.find((profile) => profile.id === id);
    if (!profile) throw new AiQuotaError("quota_conflict", "Model no longer exists.");
    if (profile.capabilities.includes("transcription")) throw new AiQuotaError("quota_conflict", "Audio pricing is not supported.");
    if (JSON.stringify(profile.pricing ?? null) !== JSON.stringify(expected))
      throw new AiQuotaError("quota_conflict", "Model prices changed. Read them again before updating.");
    if (pricing) profile.pricing = pricing;
    else delete profile.pricing;
    await setSetting(key, JSON.stringify(parsed.profiles), db);
    await audit.record(
      {
        action: "ai.model.pricing",
        outcome: "allowed",
        actor: { userId: actorId },
        target: { type: "ai-model", id },
        metadata: { pricing },
      },
      db,
    );
    return { id, pricing: profile.pricing ?? null };
  });
  await invalidateSettingsCache([key]);
  return result;
}
