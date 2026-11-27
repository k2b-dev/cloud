import { beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { meterSql, type SqlMeter } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiConfigRequestScope } from "./config-reads";
import { listAiCredentialProviderIds } from "./credentials";
import { aiModelCatalog } from "./model-catalog";
import { aiQuotas } from "./quotas";
import { readAiSettingsState } from "./settings";

// What one request costs in reads of the AI configuration: a page asks for the model settings, the providers and the
// quota rules from several of its parts, and each table is read once for all of them.
const TABLES = ["ai.providers", "ai.models", "ai.model_variants", "ai.model_assignments", "ai.provider_credentials", "ai.cost_config"];

const app = new Hono().use("*", aiConfigRequestScope).all("/ai", async (c) => {
  // The parts of one page, each asking on its own, partly at the same time.
  await Promise.all([readAiSettingsState(), readAiSettingsState(), aiModelCatalog.providers(), aiQuotas.config()]);
  await readAiSettingsState();
  await Promise.all([aiQuotas.config(), listAiCredentialProviderIds(), aiModelCatalog.providers(undefined, false)]);
  return c.body(null, 204);
});

const readsPerTable = (statements: string[]) =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      statements.filter((statement) => new RegExp(`FROM ${table.replace(".", "\\.")}\\b`).test(statement)).length,
    ]),
  );

databaseSuite()("the AI configuration in one request", () => {
  let meter: SqlMeter;
  beforeAll(async () => {
    await useMigratedDatabase("ai_config_reads");
  }, 60_000);

  const measure = async (method: string) => {
    meter = await meterSql();
    try {
      return readsPerTable(
        await meter.during(async () => {
          expect((await app.request("https://cloud.example.test/ai", { method })).status).toBe(204);
        }),
      );
    } finally {
      await meter.close();
    }
  };

  test("a GET reads each configuration table once, however many of its parts ask", async () => {
    expect(await measure("GET")).toEqual(Object.fromEntries(TABLES.map((table) => [table, 1])));
  });

  test("two requests share nothing: the second reads every table again", async () => {
    const first = await measure("GET");
    const second = await measure("GET");
    expect(second).toEqual(first);
    expect(Object.values(second).every((count) => count === 1)).toBe(true);
  });

  test("a request that writes reads the configuration every time it asks", async () => {
    const reads = await measure("POST");
    for (const table of TABLES) expect(reads[table]).toBeGreaterThan(1);
  });
});
