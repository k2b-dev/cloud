import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { set as writeSetting } from "../services/settings";
import { decryptValue } from "../services/settings/crypto";
import { getAiCredential, setAiCredential } from "./credentials";
import { migrateCloudAi } from "./migrate";
import { aiModelAccess } from "./model-access";
import { setAiModelPricing } from "./model-pricing";

const suite = databaseSuite();
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudAi();
});

suite("model reference price persistence", () => {
  test("changes only prices, keeps credentials and fields, rejects stale writes, removes prices, and rejects audio", async () => {
    const key = "ai.model_profiles_json";
    const id = `pricing-${crypto.randomUUID()}`;
    const profile = {
      id,
      label: "Private model",
      provider: "openai-compatible",
      model: "provider/model",
      enabled: true,
      capabilities: ["streaming", "tools"],
      dataBoundary: "private",
      baseURL: "https://example.test/v1",
      contextWindow: 12345,
      temperature: 0.4,
      maxOutputTokens: 777,
      maxLoadedTools: 3,
      maxToolRounds: 9,
      pricing: { inputPerMillion: 0.25, outputPerMillion: 1.5 },
    };
    const audio = {
      id: `${id}-audio`,
      label: "Audio",
      provider: "openai",
      model: "audio",
      enabled: true,
      capabilities: ["transcription"],
      dataBoundary: "hosted",
    };
    const profiles = [profile, audio];
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${id},'local','user',${id}) RETURNING id`;
    const read = async () => {
      const [row] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key}`;
      const raw = await decryptValue(row!.value);
      if (typeof raw !== "string") throw new Error("Expected model profile JSON.");
      return JSON.parse(raw);
    };
    await writeSetting(key, JSON.stringify(profiles));
    await setAiCredential(id, "test-only-provider-secret");
    await sql.begin((db) =>
      aiModelAccess.syncProfiles(
        [id, audio.id],
        [{ profileId: id, expectedRevision: null, entries: [{ principal: { type: "user", userId: user!.id }, permission: "read" }] }],
        db,
      ),
    );
    const readAccess = () => sql<{ access_id: string; revision: string }[]>`SELECT a.access_id,r.revision::text AS revision
      FROM ai.model_access a JOIN ai.model_access_resources r ON r.profile_id=a.profile_id WHERE a.profile_id=${id} ORDER BY a.access_id`;
    const access = await readAccess();
    const [credential] = await sql<{ secret: string }[]>`SELECT secret FROM ai.model_credentials WHERE profile_id=${id}`;
    const prices = { inputPerMillion: 0.125001, outputPerMillion: 0 };
    expect(await setAiModelPricing(id, prices, profile.pricing, user!.id)).toEqual({ id, pricing: prices });
    expect(await read()).toEqual([{ ...profile, pricing: prices }, audio]);
    expect(await getAiCredential(id)).toBe("test-only-provider-secret");
    expect(await sql<{ secret: string }[]>`SELECT secret FROM ai.model_credentials WHERE profile_id=${id}`).toEqual([credential!]);
    await expect(setAiModelPricing(id, null, profile.pricing, user!.id)).rejects.toThrow("Model prices changed");
    expect(await read()).toEqual([{ ...profile, pricing: prices }, audio]);
    expect(await setAiModelPricing(id, null, prices, user!.id)).toEqual({ id, pricing: null });
    const { pricing: _pricing, ...withoutPrices } = profile;
    expect(await read()).toEqual([withoutPrices, audio]);
    expect(await readAccess()).toEqual(access);
    await expect(setAiModelPricing(audio.id, prices, null, user!.id)).rejects.toThrow("Audio pricing is not supported");
    expect(await read()).toEqual([withoutPrices, audio]);
    const audit = await sql<{ action: string; target_id: string }[]>`SELECT action,target_id FROM audit.events
      WHERE actor_user_id=${user!.id}::uuid ORDER BY id`;
    expect(audit).toEqual([
      { action: "ai.model.pricing", target_id: id },
      { action: "ai.model.pricing", target_id: id },
    ]);
  });
});
