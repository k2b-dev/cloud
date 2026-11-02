import { expect, test } from "bun:test";
import { CodeAutomationTitleSchema, CodeCheckedVersionManifestSchema } from "../contracts/code-version";
import { analyzeCode } from "./checker-analysis";
import { CodeVersionManifestSchema } from "./checker-contract";
import { generateCodeSdk } from "./generator";

const sdk = generateCodeSdk([], { mode: "personal" });
const analyze = (options: string, files: Record<string, string> = {}) =>
  analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      ...files,
      "code.ts": `import { app } from "@sdk"; import { options } from "./options";
app.schedule("0 8 * * 1", async () => {}, ${options});`,
      "options.ts": files["options.ts"] ?? "export const options = {};",
    },
  });

test("schedule titles are optional reviewed metadata; the runner key and source line stay unchanged", () => {
  for (const [options, title] of [
    ['{ name: "deliver", title: "  Lieferungen eintragen  " }', "Lieferungen eintragen"],
    ['{ name: "deliver" }', undefined],
    ['{ name: "deliver", title: undefined }', undefined],
    ["options", "Lieferungen eintragen"],
  ] as const) {
    const result = analyze(options, {
      "options.ts": 'export const options = { name: "deliver", title: "Lieferungen eintragen" } as const;',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.entrypoints).toEqual([
      { kind: "schedule", entrypoint: "deliver", cron: "0 8 * * 1", file: "code.ts", line: 2, ...(title === undefined ? {} : { title }) },
    ]);
  }
});

test("dynamic, blank, oversized, markup and multiline titles are checker errors", () => {
  for (const title of [
    "String(Date.now())",
    '"   "',
    JSON.stringify("x".repeat(201)),
    '"<b>Lieferungen</b>"',
    '"one\\ntwo"',
    '"one\\u202etwo"',
  ]) {
    expect(analyze(`{ name: "deliver", title: ${title} }`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "code_static_title" }),
    );
  }
  expect(
    analyze("options", { "options.ts": 'export const options = { name: "deliver" as const, title: String(Date.now()) };' }).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "code_static_title" }));
});

test("titles are display metadata and distinct identifiers may share a title", () => {
  const result = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts": `import { app } from "@sdk";
app.schedule("0 8 * * 1", async () => {}, { name: "first", title: "Weekly review" });
app.schedule("0 9 * * 1", async () => {}, { name: "second", title: "Weekly review" });`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map(({ entrypoint, title }) => ({ entrypoint, title }))).toEqual([
    { entrypoint: "first", title: "Weekly review" },
    { entrypoint: "second", title: "Weekly review" },
  ]);
});

test("checker and stored manifests share the bounded title contract and accept old manifests", () => {
  const manifest = {
    version: 1,
    ai: false,
    permissions: [],
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    entrypoints: [{ kind: "schedule", entrypoint: "deliver", cron: "0 8 * * 1", file: "code.ts", line: 2 }],
  };
  for (const title of [undefined, "  Lieferungen eintragen  ", "x".repeat(200)]) {
    const titled = { ...manifest, entrypoints: [{ ...manifest.entrypoints[0], ...(title === undefined ? {} : { title }) }] };
    expect(CodeVersionManifestSchema.parse(titled).entrypoints[0]?.title).toBe(title?.trim());
    expect(CodeCheckedVersionManifestSchema.parse({ ...titled, entry: "code.ts", policyRows: [] }).entrypoints[0]?.title).toBe(
      title?.trim(),
    );
  }
  for (const title of ["", " ", "x".repeat(201), "<b>Title</b>", "one\ntwo", "one\u202etwo"]) {
    expect(CodeAutomationTitleSchema.safeParse(title).success).toBe(false);
    const titled = { ...manifest, entrypoints: [{ ...manifest.entrypoints[0], title }] };
    expect(CodeVersionManifestSchema.safeParse(titled).success).toBe(false);
    expect(CodeCheckedVersionManifestSchema.safeParse({ ...titled, entry: "code.ts", policyRows: [] }).success).toBe(false);
  }
});
