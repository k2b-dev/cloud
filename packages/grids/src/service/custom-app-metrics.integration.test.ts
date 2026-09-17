import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import type { CustomAppDefinition } from "../custom-apps/contracts";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { compile } from "./custom-apps";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") {
    await migrateCoreWorkflows();
    await migrate();
  }
});

describe("custom app numeric snapshot Metrics", () => {
  postgresTest("publishes only explicit bounded numeric projections while preserving aggregates", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const tableId = testUuid();
    const tableShortId = testShortId("T");
    const numberShortId = testShortId("N");
    const textShortId = testShortId("X");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Metrics')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Numbers')`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
        (${testUuid()}::uuid, ${numberShortId}, ${tableId}::uuid, 'Amount', 'number', '{}'::jsonb, 0),
        (${testUuid()}::uuid, ${textShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 1)`;
      const definition = (query: string): CustomAppDefinition => ({
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: baseShortId,
        name: "Metrics",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [
              {
                id: "home",
                columns: [{ id: "home", span: 12, blocks: [{ id: "summary", type: "metrics", source: { kind: "gql", query } }] }],
              },
            ],
          },
        ],
      });
      const source = `from table {${tableShortId}}\n`;
      for (const projection of [
        `select {${numberShortId}} as Gross\nlimit 1`,
        `select formula({${numberShortId}} * 2) as Doubled\nlimit 1`,
        `aggregate sum({${numberShortId}}) as Total`,
        "aggregate count(*) as Entries",
      ]) {
        const result = await compile(definition(source + projection));
        if (!result.ok) throw new Error(JSON.stringify({ projection, diagnostics: result.diagnostics }));
        expect(result.compiled.capabilities.insights[0]?.blockType).toBe("metrics");
      }
      for (const projection of [
        `select {${numberShortId}} as Gross`,
        `select {${numberShortId}} as Gross\nlimit 2`,
        `select {${textShortId}} as Caption\nlimit 1`,
        `select {${numberShortId}} as Gross, {${textShortId}} as Caption\nlimit 1`,
        `select formula({${numberShortId}} > 0) as Positive\nlimit 1`,
        "limit 1",
      ]) {
        const result = await compile(definition(source + projection));
        expect(result.ok, projection).toBe(false);
        if (!result.ok) {
          expect(
            result.diagnostics.some((item) => item.code === "metrics.aggregate_required"),
            JSON.stringify({ projection, diagnostics: result.diagnostics }),
          ).toBe(true);
        }
      }
      const tooMany = await compile(
        definition(
          source + `select ${Array.from({ length: 13 }, (_, i) => `formula({${numberShortId}} + ${i}) as Amount${i}`).join(", ")}\nlimit 1`,
        ),
      );
      expect(tooMany.ok).toBe(false);
      if (!tooMany.ok) expect(tooMany.diagnostics.some((item) => item.code === "metrics.aggregation_limit")).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
