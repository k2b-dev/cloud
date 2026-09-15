import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { buildFormulaSqlProjections } from "../service/computed-projections";
import { listByTable } from "../service/fields";
import { finalize } from "../service/record-finalization";
import { get } from "../service/record-read";
import { enrichRecordsWithFormulas } from "../service/relation-formulas";
import { instantiateDefinition } from "../service/templates";
import { normalizedSqlParts } from "../sql-test-utils";
import { billingAmountFields } from "./billing-lines";
import type { GridTemplate } from "./types";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("billing amount field definitions", () => {
  for (const locale of ["en", "de"]) {
    postgresTest(
      `${locale}: installed formulas agree in JS, SQL and typed finalization`,
      async () => {
        const template: GridTemplate = {
          id: "billing-amount-test",
          name: "Billing amounts",
          description: "Test",
          highlights: ["Test", "Test", "Test"],
          icon: "ti ti-receipt",
          baseName: `Billing amount test ${Bun.randomUUIDv7()}`,
          tables: [{ key: "bills", name: "Bills", finalization: { mode: "direct" }, fields: billingAmountFields("bills", locale) }],
          records: [
            {
              key: "bill",
              table: "bills",
              required: true,
              values: {
                positions: [
                  { Label1: "A", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
                  { Label1: "B", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
                  { Label1: "C", Unit01: ["C62"], Qty001: "2.5", Price1: "10.01", Vat001: ["vat007"] },
                ],
              },
            },
          ],
        };
        const created = await instantiateDefinition(template, { withSampleData: false }, null, locale);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        try {
          const [row] = await sql<Array<{ table_id: string; id: string }>>`
          SELECT r.table_id::text, r.id::text FROM grids.records r JOIN grids.tables t ON t.id = r.table_id
          WHERE t.base_id = ${created.data.id}::uuid
        `;
          if (!row) throw new Error("Missing billing sample");
          const fields = await listByTable(row.table_id);
          let projections = sql``;
          for (const projection of buildFormulaSqlProjections(fields)) projections = sql`${projections}, ${projection.fragment}`;
          const querySize = normalizedSqlParts(sql`SELECT r.* ${projections} FROM grids.records r`);
          // This six-field billing fixture previously generated 5 MB / 50k binds,
          // spending over a minute in JIT for three positions. Guard its plan shape.
          expect(querySize.text.length).toBeLessThan(1_000_000);
          expect(querySize.values.length).toBeLessThan(10_000);
          const record = await get(row.table_id, row.id);
          if (!record) throw new Error("Missing record read");
          expect(record.fieldErrors ?? {}).toEqual({});
          const definitions = template.tables[0]!.fields;
          const byKey = Object.fromEntries(
            definitions.map((definition) => {
              const field = fields.find((candidate) => candidate.name === definition.name);
              if (!field) throw new Error(`Missing ${definition.name}`);
              return [definition.key, field];
            }),
          );
          const preview = { data: { [byKey.positions!.id]: record.data[byKey.positions!.id] } };
          enrichRecordsWithFormulas([preview], fields);
          for (const [key, expected] of Object.entries({
            net7: "25.03",
            net19: "0.06",
            net: "25.09",
            tax: "1.76",
            gross: "26.85",
          })) {
            const id = byKey[key]!.id;
            expect(String(record.data[id]), `${key} SQL`).toBe(expected);
            expect(String(preview.data[id]), `${key} JS`).toBe(expected);
          }
          const frozen = await finalize({ tableId: row.table_id, recordId: row.id, actorId: null, origin: "direct" });
          expect(frozen.ok).toBe(true);
          if (!frozen.ok) throw new Error(frozen.error.message);
          for (const key of ["net7", "net19", "net", "tax", "gross"]) {
            const id = byKey[key]!.id;
            expect(frozen.data.data[id]).toBe(record.data[id]);
          }
          const [stored] = await sql<Array<{ value: unknown }>>`
          SELECT data -> ${byKey.gross!.id} AS value FROM grids.records WHERE id = ${row.id}::uuid
        `;
          expect(stored?.value).toBe("26.85");
        } finally {
          // Only this test's Base in the isolated verification database.
          await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${created.data.id}::uuid)`;
          await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${created.data.id}::uuid)`;
          await sql`DELETE FROM grids.table_finalization_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${created.data.id}::uuid)`;
          await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${created.data.id}::uuid)`;
          await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${created.data.id}::uuid)`;
          await sql`DELETE FROM grids.bases WHERE id = ${created.data.id}::uuid`;
        }
      },
      60_000,
    );
  }
});
