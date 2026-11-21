import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { fileImportManifest } from "./file-ref.test-fixture";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const core = sdkFixture("core");
core.types = [];
core.actions = [];
core.events = [];
core.queries = ["pdf.render", "sheet.to-csv", "sheet.to-ods", "finance.datev", "finance.sepa", "chart.render"].map((localId) => ({
  ...core.queries[0]!,
  localId: `file.${localId}.v1`,
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  stream: { direction: "read", maxBytes: 50 * 1024 * 1024 },
}));
const sdk = generateCodeSdk([core, fileImportManifest()], { mode: "personal" });

test("generation helpers are checked read operations and their FileRefs feed an app Action", () => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": `
import { app, pdf, sheet, finance, chart, imports } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "export" }, async () => {
  const file = await pdf.render({ name: "report.pdf" });
  await sheet.toCsv({ name: "report.csv" });
  await sheet.toOds({ name: "report.ods" });
  await finance.datev({ name: "datev.csv" });
  await finance.sepa({ name: "sepa.xml" });
  await chart.render({ name: "report.svg" });
  await imports.import({ file, idempotencyKey: "report:2026-11-11" });
});
export default app;
`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions.map((row) => row.operation)).toEqual([...core.queries.map((op) => `core.${op.localId}`), "imports.import"]);
});

test("helper aliases invoke the same generated stream operations without exposing bytes", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const ref = { id: "run-bound-file", name: "report.pdf", size: 6, mediaType: "application/pdf" };
  const calls: unknown[] = [];
  runtime.__codeSdk.bind({
    call: async (...args: unknown[]) => {
      calls.push(args);
      return ref;
    },
  });
  expect(await runtime.pdf.render({ name: "report.pdf" })).toEqual(ref);
  expect(calls).toEqual([
    [
      "core.file.pdf.render.v1",
      { call: { capability: "core.file.pdf.render.v1", target: null, refs: {}, input: { name: "report.pdf" } }, metadata: {} },
    ],
  ]);
});

test("helper namespaces cannot escape through a wrapper that erases permission evidence", () => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": `
import { app, pdf, type FileRef } from "@sdk";
function wrapper(helper: { render: (input: { name: string }) => Promise<FileRef> }) { return helper; }
const hidden = wrapper(pdf);
app.schedule({ cron: "0 8 * * *", name: "hidden" }, async () => { await hidden.render({ name: "report.pdf" }); });
export default app;
`,
    },
  });
  expect(result.diagnostics.some((row) => row.code === "code_unresolved_call")).toBe(true);
});

test("existing app namespace names remain available alongside full generation Query paths", () => {
  const withCollision = generateCodeSdk([core, sdkFixture("pdf")], { mode: "personal" });
  const result = analyzeCode({
    sdk: withCollision,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": `
import { app, core, pdf } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "report" }, async () => {
  await pdf.catalog.list({});
  await core.file.pdf.render.v1({ name: "report.pdf" });
});
export default app;
`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions.map((row) => row.operation)).toEqual(["pdf.catalog.list", "core.file.pdf.render.v1"]);
});
