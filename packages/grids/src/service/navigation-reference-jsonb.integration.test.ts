import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { updateBaseNavigation } from "./base-navigation";
import { rewriteFieldNameReferences } from "./reference-renames";
import { newShortId } from "./short-id";

const postgresTest = testFor("database");

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const fixture = async () => {
  const baseId = Bun.randomUUIDv7();
  const tableId = Bun.randomUUIDv7();
  const tableShortId = newShortId();
  await sql`INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${newShortId()}, 'JSONB writer regression')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Entries')`;
  return { baseId, tableId, tableShortId };
};

postgresTest("navigation updates store a queryable JSON array, including empty groups", async () => {
  const { baseId, tableShortId } = await fixture();
  try {
    const groupId = newShortId();
    const updated = await updateBaseNavigation(
      baseId,
      {
        revision: 0,
        groups: [{ id: groupId, name: 'Invoices "2026"', entries: [{ type: "table", id: tableShortId }] }],
      },
      null,
    );
    expect(updated.ok).toBe(true);
    const [stored] = await sql`SELECT jsonb_typeof(navigation_groups) AS kind,
      navigation_groups #>> '{0,name}' AS name,
      navigation_groups #>> '{0,entries,0,id}' AS target,
      navigation_revision AS revision FROM grids.bases WHERE id = ${baseId}::uuid`;
    expect(stored).toEqual({ kind: "array", name: 'Invoices "2026"', target: tableShortId, revision: 1 });
    const cleared = await updateBaseNavigation(baseId, { revision: 1, groups: [] }, null);
    expect(cleared.ok).toBe(true);
    const [empty] = await sql`SELECT jsonb_typeof(navigation_groups) AS kind,
      jsonb_array_length(navigation_groups) AS length FROM grids.bases WHERE id = ${baseId}::uuid`;
    expect(empty).toEqual({ kind: "array", length: 0 });
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("formula reference rewriting stores a queryable config object and retains other options", async () => {
  const { baseId, tableId } = await fixture();
  const formulaId = Bun.randomUUIDv7();
  try {
    const config = { expression: '"Old amount" * 2', outputType: "number", decimalPlaces: 2 };
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config)
      VALUES (${formulaId}::uuid, ${newShortId()}, ${tableId}::uuid, 'Total', 'formula', ${config}::jsonb)`;
    await sql.begin((tx) => rewriteFieldNameReferences({ tableId, oldName: "Old amount", newName: "New amount" }, tx));
    const [stored] = await sql`SELECT jsonb_typeof(config) AS kind,
      config ->> 'expression' AS expression, config ->> 'outputType' AS output,
      config ->> 'decimalPlaces' AS decimals FROM grids.fields WHERE id = ${formulaId}::uuid`;
    expect(stored).toEqual({ kind: "object", expression: '"New amount" * 2', output: "number", decimals: "2" });
    await rewriteFieldNameReferences({ tableId, oldName: "Unrelated", newName: "Ignored" });
    const [unchanged] = await sql`SELECT jsonb_typeof(config) AS kind, config ->> 'expression' AS expression
      FROM grids.fields WHERE id = ${formulaId}::uuid`;
    expect(unchanged).toEqual({ kind: "object", expression: '"New amount" * 2' });
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});
