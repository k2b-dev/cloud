import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { setAiCredential } from "./credentials";
import { runAiDecision } from "./decision";
import { migrateCloudAi } from "./migrate";
import { aiModelCatalog, readAiModelProfiles } from "./model-catalog";
import { aiSettingsFixture } from "./model-fixture";
import * as settings from "./settings";

const suite = databaseSuite();
suite("decision catalog and durable accounting", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("ai_decision");
    await migrateCloudAi();
  }, 120_000);
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });
  test("catalog CRUD, assignment and System One inference preserve vision, prices and measured costs", async () => {
    const id = `decision-${crypto.randomUUID()}`;
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${id},'local','user','Decision test') RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    const before = (await aiModelCatalog.assignments()).find((row) => row.slot === "decision");
    expect(before).toBeDefined();
    let read: ReturnType<typeof spyOn<typeof settings, "readAiSettingsState">> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/systemone");
        expect(request.headers.get("authorization")).toBe("Bearer fixture-key");
        expect(await request.json()).toMatchObject({ model: "clef", questions: { urgent: { type: "noul" } } });
        return Response.json({ answers: { urgent: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 40, output_tokens: 2 } });
      },
    });
    try {
      await aiModelCatalog.createProvider(
        { id, type: "openai-compatible", label: "Decision fixture", baseUrl: `${server.url}v1`, dataBoundary: "hosted" },
        user.id,
      );
      await setAiCredential(id, "fixture-key");
      await aiModelCatalog.createModels(
        id,
        [
          {
            id,
            providerModel: "clef",
            label: "Clef",
            kind: "decision",
            contextWindow: 32768,
            capabilities: ["vision"],
            pricing: { inputPerMillion: 1, outputPerMillion: 2 },
          },
        ],
        user.id,
      );
      expect(await aiModelCatalog.model(id)).toMatchObject({
        kind: "decision",
        capabilities: ["vision"],
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      });
      expect(await aiModelCatalog.variant(id)).toMatchObject({ id, slug: "standard" });
      await expect(aiModelCatalog.createVariant(id, { slug: "deep", label: "Deep" }, user.id)).rejects.toMatchObject({
        code: "invalid_configuration",
      });
      await aiModelCatalog.updateModel(id, { description: "Decision with images" }, 1, user.id);
      expect((await aiModelCatalog.model(id)).capabilities).toEqual(["vision"]);
      await aiModelCatalog.assign("decision", id, before!.revision, user.id);
      await expect(aiModelCatalog.assign("balanced", id, 1, user.id)).rejects.toMatchObject({ code: "invalid_configuration" });
      const profiles = await readAiModelProfiles();
      const fixture = aiSettingsFixture({ profiles, assignments: await aiModelCatalog.assignments() });
      read = spyOn(settings, "readAiSettingsState").mockResolvedValue(fixture);
      expect(profiles.find((profile) => profile.id === id)).toMatchObject({ kind: "decision", capabilities: ["vision"] });
      expect((await settings.listAiModels(undefined, fixture)).some((profile) => profile.id === id)).toBe(false);
      const result = await runAiDecision({
        task: id,
        state: "Customer requests immediate help",
        questions: { urgent: { type: "noul", instructions: "Is urgent?" } },
      });
      expect(result.answers.urgent).toMatchObject({ probability: 0.75, value: true });
      const [call] = await sql<
        { status: string; input: number; output: number; cost: string; reserved: string }[]
      >`SELECT status,input::int,output::int,cost::text,reserved::text FROM ai.inference_calls WHERE task=${id}`;
      expect(call).toMatchObject({ status: "ok", input: 40, output: 2 });
      expect(Number(call!.cost)).toBeCloseTo(0.000044, 9);
      expect(Number(call!.reserved)).toBe(0);
      const [run] = await sql<
        { mode: string; status: string; input_tokens: number }[]
      >`SELECT mode,status,input_tokens FROM ai.structured_runs WHERE task=${id}`;
      expect(run).toMatchObject({ mode: "decision", status: "ok", input_tokens: 40 });
    } finally {
      read?.mockRestore();
      server.stop(true);
      const assignment = (await aiModelCatalog.assignments()).find((row) => row.slot === "decision");
      if (assignment) await aiModelCatalog.assign("decision", before?.variantId ?? null, assignment.revision, user.id);
      await sql`DELETE FROM ai.providers WHERE id=${id}`;
      await sql`DELETE FROM ai.model_access_resources WHERE model_id=${id}`;
      await sql`DELETE FROM ai.inference_calls WHERE task=${id}`;
      await sql`DELETE FROM ai.structured_runs WHERE task=${id}`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  });
});
