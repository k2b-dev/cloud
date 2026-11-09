import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import {
  AiAssignmentSchema as LegacyAssignmentSchema,
  AiModelSchema as LegacyModelSchema,
  AiProviderSchema as LegacyProviderSchema,
  AiVariantSchema as LegacyVariantSchema,
} from "../../ai/catalog-v0.70.test-fixture";
import { migrateAiModelClassesInTransaction } from "../../ai/migrate";
import { aiModelCatalog } from "../../ai/model-catalog";

// This cross-schema upgrade discards settings. Give it a private database so
// neither its legacy settings fixture nor its DDL can affect another suite.
databaseSuite()("model class settings migration", () => {
  test("breaking migration resets configuration once and preserves history", async () => {
    const database = await createDisposableDatabase("model_classes");
    const db = new SQL(database.url);
    try {
      await db`CREATE SCHEMA auth; CREATE SCHEMA settings; CREATE SCHEMA ai;
        CREATE TABLE auth.users (id UUID PRIMARY KEY);
        CREATE TABLE auth.access (id UUID PRIMARY KEY);
        CREATE TABLE settings.entries (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE ai.model_access_resources (profile_id TEXT PRIMARY KEY);
        CREATE TABLE ai.model_access (profile_id TEXT REFERENCES ai.model_access_resources(profile_id) ON DELETE CASCADE, access_id UUID REFERENCES auth.access(id) ON DELETE CASCADE);
        CREATE TABLE ai.cost_config (singleton BOOLEAN PRIMARY KEY, rules JSONB, revision INTEGER);
        CREATE TABLE ai.projects (id TEXT PRIMARY KEY, default_model_profile_id TEXT);
        CREATE TABLE ai.user_prefs (user_id UUID PRIMARY KEY, last_model_id TEXT);
        CREATE TABLE ai.inference_calls (id UUID PRIMARY KEY);
        CREATE TABLE ai.messages (id UUID PRIMARY KEY);
        CREATE TABLE ai.model_credentials (profile_id TEXT PRIMARY KEY, secret TEXT);
        CREATE TABLE ai.model_request_headers (profile_id TEXT PRIMARY KEY, secret TEXT);
      `.simple();
      await db`INSERT INTO settings.entries(key,value) VALUES('ai.model_profiles_json','[]'),('ai.default_model_id','old')`;
      await db`INSERT INTO ai.cost_config VALUES(true,'[{"scope":"*"},{"scope":"old"}]'::jsonb,1)`;
      await db`INSERT INTO ai.messages VALUES('00000000-0000-4000-8000-000000000001')`;
      await db`INSERT INTO ai.inference_calls VALUES('00000000-0000-4000-8000-000000000002')`;
      await db`INSERT INTO auth.access VALUES('00000000-0000-4000-8000-000000000004')`;
      await db`INSERT INTO ai.model_access_resources VALUES('old')`;
      await db`INSERT INTO ai.model_access VALUES('old','00000000-0000-4000-8000-000000000004')`;
      await db`INSERT INTO ai.projects VALUES('project','old')`;
      await db`INSERT INTO ai.user_prefs VALUES('00000000-0000-4000-8000-000000000003','old')`;
      await db.begin(migrateAiModelClassesInTransaction);
      expect(await aiModelCatalog.models(db)).toEqual([]);
      expect((await aiModelCatalog.assignments(db)).every((row) => row.variantId === null)).toBe(true);
      const [legacy] = await db<
        { credentials: string | null; headers: string | null; settings: number }[]
      >`SELECT to_regclass('ai.model_credentials')::text AS credentials,to_regclass('ai.model_request_headers')::text AS headers,(SELECT count(*)::int FROM settings.entries WHERE key IN ('ai.model_profiles_json','ai.default_model_id')) AS settings`;
      expect(legacy).toEqual({ credentials: null, headers: null, settings: 0 });
      expect(await db<unknown[]>`SELECT * FROM auth.access`).toEqual([]);
      expect(await db<unknown[]>`SELECT * FROM ai.model_access_resources`).toEqual([]);
      expect(await db<unknown[]>`SELECT * FROM ai.model_access`).toEqual([]);
      const [rules] = await db<{ rules: { scope: string }[] }[]>`SELECT rules FROM ai.cost_config WHERE singleton`;
      expect(rules?.rules).toEqual([{ scope: "*" }]);
      const [history] = await db<{ messages: number; calls: number }[]>`SELECT
        (SELECT count(*)::int FROM ai.messages) AS messages,
        (SELECT count(*)::int FROM ai.inference_calls) AS calls`;
      expect(history).toEqual({ messages: 1, calls: 1 });
      expect(await db<{ default_model: unknown }[]>`SELECT default_model FROM ai.projects`).toEqual([{ default_model: null }]);
      expect(await db<{ model_choice: unknown }[]>`SELECT model_choice FROM ai.user_prefs`).toEqual([{ model_choice: null }]);
      await db`INSERT INTO ai.providers(id,type,label,data_boundary) VALUES('new','ollama','New','private')`;
      await db`INSERT INTO ai.models(id,provider_id,provider_model,label,kind)
        VALUES('limited','new','upstream','Limited','chat'),('unlimited','new','upstream','Unlimited','chat')`;
      await db`INSERT INTO ai.model_variants(id,model_id,slug,label) VALUES('limited','limited','standard','Standard')`;
      // Simulate a database that already ran the unreleased #2970 migration.
      await db`DROP TABLE ai.model_output_limits`;
      await db`ALTER TABLE ai.models ADD COLUMN output_token_limit INTEGER CHECK(output_token_limit > 0)`;
      await db`UPDATE ai.models SET output_token_limit=65536 WHERE id='limited'`;
      await db`INSERT INTO settings.entries(key,value) VALUES('ai.global_instructions','keep')`;
      await db.begin(migrateAiModelClassesInTransaction);
      expect(
        await db`SELECT column_name FROM information_schema.columns
        WHERE table_schema='ai' AND table_name='models' AND column_name='output_token_limit'`,
      ).toHaveLength(0);
      expect(await db<{ model_id: string; output_token_limit: number }[]>`SELECT * FROM ai.model_output_limits`).toEqual([
        { model_id: "limited", output_token_limit: 65_536 },
      ]);
      expect(await aiModelCatalog.model("limited", db)).toMatchObject({ outputTokenLimit: 65_536 });
      expect(await aiModelCatalog.model("unlimited", db)).toMatchObject({ outputTokenLimit: null });
      await db.begin(async (tx) => {
        expect(await aiModelCatalog.model("limited", tx, true)).toMatchObject({ outputTokenLimit: 65_536 });
      });
      // Query whole physical rows exactly as the 0.70 / @k2b/cloud 0.63 reader did.
      for (const [table, schema] of [
        ["providers", LegacyProviderSchema],
        ["models", LegacyModelSchema],
        ["model_variants", LegacyVariantSchema],
        ["model_assignments", LegacyAssignmentSchema],
      ] as const) {
        const rows = await db.unsafe<{ data: Record<string, unknown> }[]>(`SELECT to_jsonb(t) AS data FROM ai.${table} t`);
        expect(rows.length).toBeGreaterThan(0);
        for (const { data } of rows) {
          const decoded = Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]),
          );
          expect(
            schema.safeParse(table === "providers" ? { ...decoded, credentialSet: false, requestHeaderNames: [] } : decoded).success,
          ).toBe(true);
        }
      }
      await db.begin(migrateAiModelClassesInTransaction);
      expect(await db<{ model_id: string; output_token_limit: number }[]>`SELECT * FROM ai.model_output_limits`).toEqual([
        { model_id: "limited", output_token_limit: 65_536 },
      ]);
      expect((await aiModelCatalog.providers(db, false)).map((row) => row.id)).toEqual(["new"]);
      expect(await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key='ai.global_instructions'`).toEqual([
        { value: "keep" },
      ]);
      await db`DELETE FROM ai.providers WHERE id='new'`;
      expect(await db<{ model_id: string; output_token_limit: number }[]>`SELECT * FROM ai.model_output_limits`).toEqual([]);
    } finally {
      await db.close();
      await database.drop();
    }
  });
});
