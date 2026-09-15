import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { parseJsonbRow } from "./jsonb";
import * as records from "./record-write";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
}, 30_000);

type DefaultCase = {
  name: string;
  type: string;
  config?: Record<string, unknown>;
  values: [unknown, unknown];
  path?: string[];
};

const cases: DefaultCase[] = [
  { name: "ordinary text", type: "text", values: ["initial", "updated"] },
  { name: "JSON-looking text", type: "text", values: ['{"kind":"now"}', '"quoted"'] },
  { name: "array-looking and malformed text", type: "text", values: ['["x"]', "{broken"] },
  { name: "literal text", type: "text", values: ["true", "null"] },
  { name: "numeric text", type: "text", values: ["42", "0"] },
  { name: "numeric duration", type: "duration", values: [0, 90] },
  { name: "boolean", type: "boolean", values: [false, true] },
  { name: "exact decimal", type: "number", config: { decimalPlaces: 2 }, values: ["0.10", "2.30"] },
  { name: "dynamic date", type: "date", values: [{ kind: "now" }, { kind: "now" }], path: ["kind"] },
  {
    name: "select array",
    type: "select",
    config: {
      options: [
        { id: "open", label: "Open" },
        { id: "closed", label: "Closed" },
      ],
    },
    values: [["open"], ["closed"]],
    path: ["0"],
  },
  {
    name: "object-list array",
    type: "object_list",
    config: { fields: [{ id: "Amount", name: "Amount", type: "number" }] },
    values: [[{ Amount: "1.5" }], [{ Amount: "2.5" }]],
    path: ["0", "Amount"],
  },
  { name: "no default", type: "text", values: [undefined, null] },
];

for (const entry of cases) {
  postgresTest(
    `field create/update stores queryable JSONB defaults: ${entry.name}`,
    async () => {
      const baseId = testUuid();
      const tableId = testUuid();
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'JSONB defaults')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Defaults')`;
      try {
        const created = await fields.create(
          {
            tableId,
            name: entry.name,
            type: entry.type,
            config: entry.config,
            defaultValue: entry.values[0],
          },
          null,
        );
        if (!created.ok) throw new Error(created.error.message);
        const fieldId = created.data.id;
        // A name-only change must preserve the native default just read from
        // storage, rather than silently re-encoding or parsing it.
        for (const [index, expectedInput] of [entry.values[0], entry.values[0], entry.values[1]].entries()) {
          const expected = expectedInput ?? null;
          const result =
            index === 0
              ? created
              : await fields.update(
                  fieldId,
                  index === 1 ? { name: `${entry.name} renamed` } : { name: `${entry.name} updated`, defaultValue: expected },
                  null,
                );
          if (!result.ok) throw new Error(result.error.message);
          const [stored] = await sql`SELECT jsonb_typeof(default_value) AS kind,
          default_value #>> ${sql.array(entry.path ?? [], "TEXT")} AS selected,
          jsonb_typeof(config) AS config_kind, default_value IS NULL AS absent
          FROM grids.fields WHERE id = ${fieldId}::uuid`;
          const kind = expected === null ? null : Array.isArray(expected) ? "array" : typeof expected;
          let selected: unknown = expected;
          for (const key of entry.path ?? []) selected = (selected as Record<string, unknown>)[key];
          expect(stored).toEqual({
            kind,
            selected: selected === null ? null : String(selected),
            config_kind: "object",
            absent: expected === null,
          });
          expect(result.data.defaultValue).toEqual(expected);
          expect((await fields.get(fieldId))?.defaultValue).toEqual(expected);
        }
        const cleared = await fields.update(fieldId, { defaultValue: null }, null);
        if (!cleared.ok) throw new Error(cleared.error.message);
        const [empty] = await sql`SELECT default_value IS NULL AS absent FROM grids.fields WHERE id = ${fieldId}::uuid`;
        expect(empty.absent).toBe(true);
        expect(cleared.data.defaultValue).toBeNull();
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
}

postgresTest("record creation preserves JSON-looking text defaults verbatim", async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'JSONB record defaults')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Defaults')`;
  try {
    const value = '["x"]';
    const field = await fields.create({ tableId, name: "Text", type: "text", defaultValue: value }, null);
    if (!field.ok) throw new Error(field.error.message);
    const record = await records.create(tableId, {}, null, "direct");
    if (!record.ok) throw new Error(record.error.message);
    const [stored] = await sql`SELECT jsonb_typeof(data -> ${field.data.id}::text) AS kind,
      data ->> ${field.data.id}::text AS value FROM grids.records WHERE id = ${record.data.id}::uuid`;
    expect(stored).toEqual({ kind: "string", value });
    expect(record.data.data[field.data.id]).toBe(value);
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("Bun JSONB bindings distinguish serialized text from native objects", async () => {
  const object = { a: 1 };
  const serialized = JSON.stringify(object);
  const [row] = await sql`SELECT
    jsonb_typeof(${serialized}::jsonb) AS double_encoded_kind,
    jsonb_typeof(${serialized}::text::jsonb) AS text_kind,
    (${serialized}::text::jsonb) ->> 'a' AS text_value,
    jsonb_typeof(${object}::jsonb) AS object_kind,
    (${object}::jsonb) ->> 'a' AS object_value`;
  expect(row).toEqual({ double_encoded_kind: "string", text_kind: "object", text_value: "1", object_kind: "object", object_value: "1" });

  // Check the actual driver boundary, not only the helper with hand-built JS.
  for (const value of [object, [1, 2], '["x"]', "{broken", '"quoted"', false, 0, null]) {
    const [native] = await sql`SELECT ${JSON.stringify(value)}::text::jsonb AS value`;
    expect(native.value).toEqual(value);
    expect(parseJsonbRow<unknown>(native.value, null)).toEqual(value);
  }
});
