import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { ConfigConflict } from "../services/config-conflict";
import { getAiCredential, setAiCredential } from "./credentials";
import { migrateAiModelClassesInTransaction, migrateCloudAi } from "./migrate";
import { aiModelCatalog } from "./model-catalog";
import { deleteAiCatalogEntry } from "./model-delete";
import { aiProjects } from "./projects";
import { userResourceContext } from "./projects.test-fixture";
import { getAiRequestHeaders, setAiRequestHeaders } from "./request-headers";

const suite = databaseSuite();
suite("AI model catalog migration and revisions", () => {
  beforeAll(migrateCloudAi);
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
      expect(await getAiCredential(id)).toBe("fixture-provider-key");
      await sql`UPDATE ai.providers SET status='ok',status_code='200',status_message='Ready',status_checked_at='2026-10-27T00:00:00Z' WHERE id=${id}`;
      const changed = await aiModelCatalog.updateProvider(id, { baseUrl: "http://localhost:1234" }, provider.revision + 1, user.id);
      expect(changed).toMatchObject({
        credentialSet: false,
        status: "unknown",
        statusCode: null,
        statusMessage: null,
        statusCheckedAt: null,
      });
      expect(await getAiCredential(id)).toBeNull();
      expect(await getAiRequestHeaders(id)).toEqual({});
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
    const subject = userResourceContext({ type: "user", userId: user.id });
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
