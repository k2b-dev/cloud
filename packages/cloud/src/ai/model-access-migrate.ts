import { sql } from "bun";
import { decryptValue } from "../services/settings/crypto";
import { aiModelAccess } from "./model-access";
import { parseAiModelProfiles } from "./settings";

export const migrateAiModelAccess = async (): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`CREATE SEQUENCE IF NOT EXISTS ai.model_access_revision`;
    await tx`CREATE TABLE IF NOT EXISTS ai.model_access_resources (
      profile_id TEXT PRIMARY KEY,
      revision BIGINT NOT NULL DEFAULT nextval('ai.model_access_revision')
    )`;
    await tx`CREATE TABLE IF NOT EXISTS ai.model_access (
      profile_id TEXT NOT NULL REFERENCES ai.model_access_resources(profile_id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (profile_id, access_id), UNIQUE (access_id)
    )`;
    // Read authoritative configuration, not a possibly stale Redis settings snapshot.
    const [setting] = await tx<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'ai.model_profiles_json' FOR UPDATE`;
    const raw = setting ? await decryptValue(setting.value) : "[]";
    if (typeof raw !== "string") throw new Error("Model profiles must be a JSON array string.");
    const parsed = parseAiModelProfiles(raw);
    if (parsed.error) throw new Error(parsed.error.message);
    await aiModelAccess.syncProfiles(
      parsed.profiles.map((profile) => profile.id),
      [],
      tx,
    );
  });
};
