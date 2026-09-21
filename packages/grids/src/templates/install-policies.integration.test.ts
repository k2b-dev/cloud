import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listTemplatesForTable } from "../service/document-templates";
import * as durableHistory from "../service/durable-history";
import * as finalization from "../service/record-finalization";
import { create as createRecord } from "../service/record-write";
import { instantiateDefinition } from "../service/templates";
import { formula, type GridTemplate, table } from "./types";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const definition = (): GridTemplate => ({
  id: "installer-test",
  name: "Installer test",
  description: "Internal installer fixture",
  highlights: ["Setup", "History", "Issuance"],
  icon: "ti ti-file",
  baseName: `Installer ${Bun.randomUUIDv7()}`,
  tables: [
    {
      key: "bills",
      name: "Bills",
      finalization: { mode: "direct" },
      mutationPolicy: { mode: "selected", sources: ["workflow"] },
      fields: [
        { key: "name", name: "Name", type: "text", presentable: true },
        { key: "number", name: "Final ID", type: "id", config: { strategy: "sequence", assignment: "finalization" } },
      ],
    },
  ],
  records: [
    { key: "setup", table: "bills", required: true, values: { name: "Configure issuer" } },
    ...Array.from({ length: 101 }, (_, index) => ({ key: `sample-${index}`, table: "bills", values: { name: `Sample ${index}` } })),
  ],
  documentTemplates: [
    {
      key: "invoice",
      table: "bills",
      name: "Invoice",
      source: formula("from table ", table("bills"), " limit 1"),
      renderer: { kind: "profile", id: "de.zugferd.en16931", version: 2, inputTemplate: "{}" },
      issuancePolicy: "oncePerFinalizedRecord",
    },
  ],
});

const cleanup = async (baseId: string) => {
  await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

describe("template setup and lifecycle policies", () => {
  for (const withSampleData of [false, true]) {
    postgresTest(
      `installs required setup and completes history, samples=${withSampleData}`,
      async () => {
        const template = definition();
        const created = await instantiateDefinition(template, { withSampleData }, null);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        try {
          const [target] = await sql<Array<{ id: string; mutation_policy: unknown }>>`
          SELECT id::text, mutation_policy FROM grids.tables WHERE base_id = ${created.data.id}::uuid
        `;
          if (!target) throw new Error("Missing installed table");
          expect(target.mutation_policy).toEqual({ mode: "selected", sources: ["workflow"] });
          const [count] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${target.id}::uuid
        `;
          expect(count?.count).toBe(withSampleData ? 102 : 1);
          const history = await durableHistory.getStatus(target.id);
          expect(history).toMatchObject({
            ok: true,
            data: {
              enabled: true,
              status: "active",
              baseline: { captured: 0, total: 0 },
            },
          });
          const [versions] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.record_revisions WHERE table_id = ${target.id}::uuid AND action = 'created'
        `;
          expect(versions?.count).toBe(withSampleData ? 102 : 1);
          expect(await finalization.getStatus(target.id)).toMatchObject({ ok: true, data: { enabled: true, mode: "direct" } });
          expect((await createRecord(target.id, {}, null, "direct")).ok).toBe(false);
          expect((await createRecord(target.id, {}, null, "workflow")).ok).toBe(true);
          const documents = await listTemplatesForTable(target.id);
          expect(documents).toHaveLength(1);
          expect(documents[0]).toMatchObject({
            issuancePolicy: "oncePerFinalizedRecord",
            renderer: {
              kind: "profile",
              id: "de.zugferd.en16931",
              version: 2,
            },
          });
        } finally {
          await cleanup(created.data.id);
        }
      },
      60_000,
    );
  }

  postgresTest("removes an unfinished Base including its captured baseline after a later failure", async () => {
    const template = definition();
    template.documentTemplates = [{ key: "invalid", table: "bills", starterId: "does-not-exist" }];
    const result = await instantiateDefinition(template, { withSampleData: false }, null);
    expect(result.ok).toBe(false);
    const remaining = await sql`SELECT id FROM grids.bases WHERE name = ${template.baseName}`;
    expect(remaining).toHaveLength(0);
  });
});
