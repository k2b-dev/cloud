import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { parse } from "yaml";
import { parseGridsQueryDsl } from "../../../query-dsl/parser";
import { buildWorkflowCatalog } from "../../../service/workflow-catalog";
import { compileAndBindGridsWorkflowSource } from "../../../workflows/binder";
import { type FreeQueryOutput, queryExportWorkflowSource } from "./query-export-workflow-source";

const catalog = buildWorkflowCatalog({
  tables: [{ id: "11111111-1111-4111-8111-111111111111", shortId: "TBL001", name: "Items", kind: "stored" }],
  fieldsByTable: new Map(),
  templates: [],
  emailTemplates: [],
});
const outputs: FreeQueryOutput[] = [
  { kind: "csv", delimiter: ";" },
  { kind: "json" },
  { kind: "csv", delimiter: "|", nestedValues: "json", textProtection: "raw" },
  { kind: "json", wrapper: { rowsKey: "items" } },
  { kind: "pdf", body: "<p>Report</p>", header: "<p>Header</p>", footer: "<p>Footer</p>", css: "p { color: #333; }" },
  { kind: "pdf", body: "<p>{% for row in rows %}{{ row.name }}{% endfor %}</p>" },
  { kind: "xml", body: "<report>{% for row in rows %}<name>{{ row.name }}</name>{% endfor %}</report>" },
];
for (const output of outputs) {
  test(`query export starter compiles ${output.kind} using one named result`, async () => {
    const query = "from table {TBL001}\nselect Name as name";
    const source = queryExportWorkflowSource(query, output);
    const result = await compileAndBindGridsWorkflowSource(source, catalog, async (value) => {
      expect(value).toBe(query);
      expect(parseGridsQueryDsl(value).ok).toBe(true);
      return ok({ source: value, schemaHash: "a".repeat(64) });
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    expect(parse(source)).toEqual({
      steps: [{ query: { source: query, saveAs: "report" } }, { generateDocument: { data: "report", output, saveAs: "exported" } }],
    });
  });
}
test("query export starter preserves parameters and template text without creating YAML steps", () => {
  const parameters = { amount: { type: "decimal" as const, value: "123456789.1234" } };
  const query = "from table Items\nwhere Amount > @params.amount";
  const body = "---\nsteps:\n  - fail: injected\n{{ rows[0].name }}";
  const parsed = parse(queryExportWorkflowSource(query, { kind: "pdf", body }, parameters));
  expect(parsed.steps).toHaveLength(2);
  expect(parsed.steps[0].query.parameters).toEqual(parameters);
  expect(parsed.steps[0].query.source).toBe(query);
  expect(parsed.steps[1].generateDocument.output.body).toBe(body);
});

test("query export run inputs bind exact decimals as text without saving preview values", async () => {
  const source = queryExportWorkflowSource("from table {TBL001}\nwhere Amount > @params.minimum", { kind: "csv" }, undefined, [
    { name: "minimum", type: "decimal" },
  ]);
  const result = await compileAndBindGridsWorkflowSource(source, catalog, async (query) =>
    ok({ source: query, schemaHash: "a".repeat(64) }),
  );
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  expect(parse(source).inputs.minimum).toEqual({ type: "text", required: true });
  expect(parse(source).steps[0].query.parameters.minimum).toEqual({ type: "decimal", value: "${{ inputs.minimum }}" });
});
