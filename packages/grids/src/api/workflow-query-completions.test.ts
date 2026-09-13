import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { buildWorkflowCatalog } from "../service/workflow-catalog";
import { compileAndBindGridsWorkflowSource } from "../workflows/binder";
import { buildWorkflowCompletions } from "./workflow-api-shared";

test("editor result suggestions insert a reference accepted by the normal workflow binder", async () => {
  const catalog = buildWorkflowCatalog({ tables: [], fieldsByTable: new Map(), templates: [], emailTemplates: [] });
  const source =
    'steps:\n  - query:\n      source: from table Items\n      saveAs: report\n  - generateDocument:\n      data: "re\n      output: {kind: csv}\n';
  const items = buildWorkflowCompletions(source, source.indexOf('"re') + 3, catalog, "de");
  expect(items.map((item) => item.label)).toEqual(["report"]);
  const edit = items[0]!.textEdit;
  expect(source.slice(edit.start, edit.end)).toBe('"re');
  const completed = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const result = await compileAndBindGridsWorkflowSource(completed, catalog, async (query) =>
    ok({ source: query, schemaHash: "a".repeat(64) }),
  );
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
});
