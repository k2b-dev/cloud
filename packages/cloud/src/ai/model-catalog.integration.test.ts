import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { ConfigConflict } from "../services/config-conflict";
import { getAiCredential, setAiCredential } from "./credentials";
import { migrateAiModelClassesInTransaction, migrateCloudAi } from "./migrate";
import { aiModelCatalog } from "./model-catalog";
import { deleteAiCatalogEntry } from "./model-delete";
import { aiProjects } from "./projects";
import { getAiRequestHeaders, setAiRequestHeaders } from "./request-headers";

const suite = databaseSuite();
suite("AI model catalog migration and revisions", () => {
  beforeAll(migrateCloudAi);
  test("breaking migration resets configuration once and preserves history", async () => {
    const rolledBack = new Error("rollback migration fixture");
    await expect(
      sql.begin(async (db) => {
        const [before] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.messages`;
        await db`DROP TABLE ai.model_assignments`;
        await db`DROP TABLE ai.providers CASCADE`;
        await db`DROP TABLE ai.models CASCADE`;
        await db`DROP TABLE ai.model_variants CASCADE`;
        await db`ALTER TABLE ai.projects ADD COLUMN default_model_profile_id TEXT`;
        await db`ALTER TABLE ai.user_prefs ADD COLUMN last_model_id TEXT`;
        await db`CREATE TABLE ai.model_credentials(profile_id TEXT PRIMARY KEY,secret TEXT)`;
        await db`CREATE TABLE ai.model_request_headers(profile_id TEXT PRIMARY KEY,secret TEXT)`;
        await db`INSERT INTO settings.entries(key,value) VALUES('ai.model_profiles_json','[]'),('ai.default_model_id','old') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        await db`UPDATE ai.cost_config SET rules='[{"scope":"*"},{"scope":"old"}]'::jsonb WHERE singleton`;
        await db`ALTER TABLE ai.model_access_resources RENAME COLUMN model_id TO profile_id`;
        await db`ALTER TABLE ai.model_access RENAME COLUMN model_id TO profile_id`;
        await migrateAiModelClassesInTransaction(db);
        expect(await aiModelCatalog.models(db)).toEqual([]);
        expect((await aiModelCatalog.assignments(db)).every((row) => row.variantId === null)).toBe(true);
        const [legacy] = await db<
          { credentials: string | null; headers: string | null; settings: number }[]
        >`SELECT to_regclass('ai.model_credentials')::text AS credentials,to_regclass('ai.model_request_headers')::text AS headers,(SELECT count(*)::int FROM settings.entries WHERE key IN ('ai.model_profiles_json','ai.default_model_id')) AS settings`;
        expect(legacy).toEqual({ credentials: null, headers: null, settings: 0 });
        const [rules] = await db<{ rules: { scope: string }[] }[]>`SELECT rules FROM ai.cost_config WHERE singleton`;
        expect(rules?.rules).toEqual([{ scope: "*" }]);
        const [after] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.messages`;
        expect(after?.count).toBe(before?.count);
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);
  });
  test("provider secrets are encrypted, rows are revisioned, and standard variants are automatic", async () => {
    const id = `catalog-${crypto.randomUUID()}`;
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${id},'local','user','Catalog test') RETURNING id`;
    if (!user) throw new Error("Missing test user");
    try {
      const provider = await aiModelCatalog.createProvider({ id, type: "ollama", label: "Test", dataBoundary: "private" }, user.id);
      await setAiCredential(id, "fixture-provider-key");
      await setAiRequestHeaders(id, { "X-Test": "fixture-header" });
      const [stored] = await sql<{ secret: string }[]>`SELECT secret FROM ai.provider_credentials WHERE provider_id=${id}`;
      expect(stored?.secret).not.toContain("fixture-provider-key");
      expect(await getAiCredential(id)).toBe("fixture-provider-key");
      expect(await getAiRequestHeaders(id)).toEqual({ "X-Test": "fixture-header" });
      const shown = await aiModelCatalog.provider(id);
      expect(shown.credentialSet).toBe(true);
      expect(JSON.stringify(shown)).not.toContain("fixture-provider-key");
      const [model] = await aiModelCatalog.createModels(id, [{ id, label: "Test", providerModel: "test" }], user.id);
      expect(model?.id).toBe(id);
      const access = (await aiModelCatalog.modelDetail(id)).access;
      await expect(
        aiModelCatalog.updateModel(id, { label: "Must roll back" }, 1, user.id, {
          expectedRevision: access?.revision ?? null,
          entries: [{ principal: { type: "user", userId: crypto.randomUUID() }, permission: "read" }],
        }),
      ).rejects.toThrow();
      expect((await aiModelCatalog.model(id)).label).toBe("Test");
      expect(await getAiCredential(id)).toBe("fixture-provider-key");
      expect(await getAiRequestHeaders(id)).toEqual({ "X-Test": "fixture-header" });
      expect(await aiModelCatalog.variant(id)).toMatchObject({ id, modelId: id, slug: "standard" });
      await aiModelCatalog.updateProvider(id, { label: "Changed" }, provider.revision, user.id);
      await expect(aiModelCatalog.updateProvider(id, { label: "Stale" }, provider.revision, user.id)).rejects.toBeInstanceOf(
        ConfigConflict,
      );
      await sql.begin(migrateAiModelClassesInTransaction);
      expect((await aiModelCatalog.provider(id)).label).toBe("Changed");
    } finally {
      await sql`DELETE FROM ai.providers WHERE id=${id}`;
      await sql`DELETE FROM ai.model_access_resources WHERE model_id=${id}`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  });
  test("deleting a mixed provider retargets chat references, records notices and requires each slot", async () => {
    const suffix = crypto.randomUUID();
    const sourceId = `source-${suffix}`;
    const targetId = `target-${suffix}`;
    const audioId = `audio-${suffix}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${suffix},'local','user','Model replacement owner') RETURNING id`;
    if (!user) throw new Error("Missing replacement owner");
    const subject = { type: "user", userId: user.id } satisfies import("../server").AccessSubject;
    const before = (await aiModelCatalog.assignments()).find((row) => row.slot === "fast");
    if (!before) throw new Error("Missing fast assignment");
    const project = await aiProjects.create({ subject, name: "Retarget fixture", defaultModel: { id: sourceId } });
    try {
      const provider = await aiModelCatalog.createProvider(
        { id: sourceId, type: "openai-compatible", label: "Source", baseUrl: "http://localhost:1/v1", dataBoundary: "private" },
        user.id,
      );
      await aiModelCatalog.createProvider({ id: targetId, type: "ollama", label: "Target", dataBoundary: "private" }, user.id);
      await aiModelCatalog.createModels(
        sourceId,
        [
          { id: sourceId, label: "Chat", providerModel: "chat", capabilities: ["tools"] },
          { id: audioId, label: "Audio", providerModel: "audio", kind: "transcription" },
        ],
        user.id,
      );
      await aiModelCatalog.createModels(
        targetId,
        [{ id: targetId, label: "Replacement", providerModel: "chat", capabilities: ["tools"] }],
        user.id,
      );
      await aiModelCatalog.assign("fast", sourceId, before.revision, user.id);
      await expect(aiModelCatalog.updateModel(sourceId, { capabilities: [], kind: "transcription" }, 1, user.id)).rejects.toMatchObject({
        code: "invalid_configuration",
      });
      await expect(
        deleteAiCatalogEntry("variant", sourceId, { revision: 1, replacements: {}, retarget: false, retargetTo: null }, user.id),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
      await expect(
        deleteAiCatalogEntry(
          "provider",
          sourceId,
          { revision: provider.revision, replacements: {}, retarget: true, retargetTo: targetId },
          user.id,
        ),
      ).rejects.toMatchObject({ code: "invalid_configuration" });
      expect(
        await deleteAiCatalogEntry(
          "provider",
          sourceId,
          { revision: provider.revision, replacements: { fast: targetId }, retarget: true, retargetTo: targetId },
          user.id,
        ),
      ).toEqual({ deleted: true });
      const [stored] = await sql<{ default_model: { id: string } }[]>`SELECT default_model FROM ai.projects WHERE id=${project.id}::uuid`;
      expect(stored?.default_model).toEqual({ id: targetId });
      expect((await aiModelCatalog.assignments()).find((row) => row.slot === "fast")?.variantId).toBe(targetId);
      const notices = await sql<
        { name: string; retargeted: boolean }[]
      >`SELECT name,retargeted FROM ai.model_change_notices WHERE user_id=${user.id}::uuid`;
      expect(notices).toEqual([{ name: "Retarget fixture", retargeted: true }]);
    } finally {
      await sql`UPDATE ai.model_assignments SET variant_id=${before.variantId},revision=revision+1 WHERE slot='fast'`;
      await aiProjects.delete(project.id, subject);
      await sql`DELETE FROM ai.providers WHERE id IN (${sourceId},${targetId})`;
      await sql`DELETE FROM ai.model_access_resources WHERE model_id IN (${sourceId},${targetId},${audioId})`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  });
});
