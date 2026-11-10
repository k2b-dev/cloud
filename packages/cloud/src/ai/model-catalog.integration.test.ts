import { beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { ConfigConflict } from "../services/config-conflict";
import { AiModelSchema as LegacyAiModelSchema } from "./catalog-v0.70.test-fixture";
import { getAiCredential, setAiCredential } from "./credentials";
import { migrateAiModelClassesInTransaction, migrateCloudAi } from "./migrate";
import { aiModelCatalog, readAiModelProfiles } from "./model-catalog";
import { deleteAiCatalogEntry } from "./model-delete";
import { aiSettingsFixture } from "./model-fixture";
import { personalAiModelPolicy } from "./personal-agent";
import { aiProjects } from "./projects";
import { userResourceContext } from "./projects.test-fixture";
import { getAiRequestHeaders, setAiRequestHeaders } from "./request-headers";
import { selectAiModelProfile } from "./settings";
import type { AiModelPolicy } from "./types";

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
      const [model] = await aiModelCatalog.createModels(
        id,
        [{ id, label: "Test", providerModel: "test", outputTokenLimit: 65_536 }],
        user.id,
      );
      expect(model?.id).toBe(id);
      expect(model?.outputTokenLimit).toBe(65_536);
      const [legacyRow] = await sql<{ data: Record<string, unknown> }[]>`SELECT to_jsonb(t) AS data FROM ai.models t WHERE id=${id}`;
      if (!legacyRow) throw new Error("Missing stored model");
      const decoded = Object.fromEntries(
        Object.entries(legacyRow.data).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]),
      );
      expect(LegacyAiModelSchema.parse(decoded).id).toBe(id);
      expect(
        await sql<{ output_token_limit: number }[]>`SELECT output_token_limit FROM ai.model_output_limits WHERE model_id=${id}`,
      ).toEqual([{ output_token_limit: 65_536 }]);
      expect((await readAiModelProfiles()).find((profile) => profile.id === id)?.outputTokenLimit).toBe(65_536);
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
      if (!model) throw new Error("Missing test model");
      const updated = await aiModelCatalog.updateModel(id, { outputTokenLimit: 32_768 }, model.revision, user.id);
      expect(updated.outputTokenLimit).toBe(32_768);
      const renamed = await aiModelCatalog.updateModel(id, { label: "Renamed" }, updated.revision, user.id);
      expect(renamed.outputTokenLimit).toBe(32_768);
      const cleared = await aiModelCatalog.updateModel(id, { outputTokenLimit: null }, renamed.revision, user.id);
      expect(cleared.outputTokenLimit).toBeNull();
      expect(await sql<unknown[]>`SELECT * FROM ai.model_output_limits WHERE model_id=${id}`).toEqual([]);
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
  test("restricted providers keep their boundary, serve only apps by ID, and never reach classes or chat access", async () => {
    const suffix = crypto.randomUUID();
    const id = `restricted-${suffix}`;
    const hostedId = `hosted-${suffix}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${suffix},'local','user','Restricted boundary owner') RETURNING id`;
    if (!user) throw new Error("Missing restricted boundary owner");
    const fast = (await aiModelCatalog.assignments()).find((row) => row.slot === "fast");
    if (!fast) throw new Error("Missing fast assignment");
    try {
      const provider = await aiModelCatalog.createProvider(
        { id, type: "openai-compatible", label: "Free", baseUrl: "http://localhost:1/v1", dataBoundary: "restricted" },
        user.id,
      );
      expect(provider.dataBoundary).toBe("restricted");
      await expect(
        aiModelCatalog.createModels(id, [{ id: `${id}-audio`, label: "Audio", providerModel: "audio", kind: "transcription" }], user.id),
      ).rejects.toMatchObject({ code: "restricted_boundary" });
      const [model] = await aiModelCatalog.createModels(id, [{ id, label: "Free", providerModel: "free" }], user.id);
      if (!model) throw new Error("Missing restricted model");
      const detail = await aiModelCatalog.modelDetail(id);
      expect(detail.access?.entries).toEqual([]);
      await expect(
        aiModelCatalog.updateModel(id, {}, model.revision, user.id, {
          expectedRevision: detail.access?.revision ?? null,
          entries: [{ principal: { type: "authenticated" }, permission: "read" }],
        }),
      ).rejects.toMatchObject({ code: "restricted_boundary" });
      await expect(
        aiModelCatalog.updateModel(id, { kind: "transcription", capabilities: [] }, model.revision, user.id),
      ).rejects.toMatchObject({
        code: "restricted_boundary",
      });
      await expect(aiModelCatalog.assign("fast", id, fast.revision, user.id)).rejects.toMatchObject({ code: "restricted_boundary" });
      await expect(aiModelCatalog.updateProvider(id, { dataBoundary: "hosted" }, provider.revision, user.id)).rejects.toMatchObject({
        code: "boundary_fixed",
      });
      expect((await aiModelCatalog.updateProvider(id, { label: "Gemini" }, provider.revision, user.id)).dataBoundary).toBe("restricted");

      const hosted = await aiModelCatalog.createProvider(
        { id: hostedId, type: "ollama", label: "Hosted", dataBoundary: "hosted" },
        user.id,
      );
      await expect(aiModelCatalog.updateProvider(hostedId, { dataBoundary: "restricted" }, hosted.revision, user.id)).rejects.toMatchObject(
        {
          code: "boundary_fixed",
        },
      );
      expect((await aiModelCatalog.updateProvider(hostedId, { dataBoundary: "private" }, hosted.revision, user.id)).dataBoundary).toBe(
        "private",
      );

      const state = aiSettingsFixture({ profiles: await readAiModelProfiles() });
      const apps: AiModelPolicy = { kind: "selectable", allowedDataBoundaries: ["private", "hosted", "restricted"] };
      expect(selectAiModelProfile(state, apps, { id }).dataBoundary).toBe("restricted");
      expect(() => selectAiModelProfile(state, personalAiModelPolicy, { id })).toThrow("no data-protection commitment");

      expect(
        await deleteAiCatalogEntry(
          "provider",
          id,
          { revision: provider.revision + 1, replacements: {}, retarget: false, retargetTo: null },
          user.id,
        ),
      ).toEqual({ deleted: true });
      expect(() => selectAiModelProfile(aiSettingsFixture({ profiles: [] }), apps, { id })).toThrow("does not exist");
    } finally {
      await sql`UPDATE ai.model_assignments SET variant_id=${fast.variantId},revision=revision+1 WHERE slot='fast'`;
      await sql`DELETE FROM ai.providers WHERE id IN (${id},${hostedId})`;
      await sql`DELETE FROM ai.model_access_resources WHERE model_id=${id}`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  });
});
