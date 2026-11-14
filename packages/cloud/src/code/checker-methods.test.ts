import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CapabilityManifestSchema } from "../contracts";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";

// Analysis is the checker's first stage: a diagnostic stops checking before the native compiler or bundler runs.
// Compile in Spaces' module context: its @/ imports belong to that application, not Cloud's typecheck.
const compile = Bun.spawnSync([
  process.execPath,
  "--no-env-file",
  "-e",
  `
  import { compileCapabilityManifest } from ${JSON.stringify(resolve(import.meta.dir, "../capabilities/testing.ts"))};
  import { spacesCapabilities } from ${JSON.stringify(resolve(import.meta.dir, "../../../spaces/src/capabilities.ts"))};
  console.log(JSON.stringify(compileCapabilityManifest("spaces", spacesCapabilities)));
`,
]);
if (compile.exitCode !== 0) throw new Error(compile.stderr.toString());
const sdk = generateCodeSdk([CapabilityManifestSchema.parse(JSON.parse(compile.stdout.toString()))], { mode: "personal" });
const source = (body: string) => `import { app, spaces } from "@sdk";
const space = spaces.space("Spc001");
app.schedule({ cron: "0 8 * * 1", name: "tasks" }, async () => { ${body} });
export default app;`;

test.each([
  ["task", "en"],
  ["task", "de"],
  ["event", "en"],
  ["event", "de"],
])("unknown Space SDK method space.%s.list suggests the exact real paginated query (%s)", (method, locale) => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    locale,
    entry: "code.ts",
    files: { "code.ts": source(`await space.${method}.list({});`) },
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "code_unresolved_call",
      message: expect.stringContaining(`space.${method}.list`),
    }),
  );
  expect(result.diagnostics.some((d) => d.message.includes(`spaces.${method}.list`))).toBe(true);
  expect(
    result.diagnostics.filter((d) => d.message.startsWith(locale === "de" ? "Unbekannte SDK-Methode" : "Unknown SDK method")),
  ).toHaveLength(1);
  expect(result.diagnostics.some((d) => d.message.includes("spaces.calendar.list"))).toBe(false);
});

test("unknown method feedback normalizes a dynamic receiver without copying its arguments", () => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": source(`
    await spaces.space(String(Date.now())).task.list({});
  `),
    },
  });
  const named = result.diagnostics.find((d) => d.message.startsWith("Unknown SDK method"));
  expect(named?.message).toContain("spaces.space(id).task.list");
  expect(named?.message).not.toContain("Date.now");
  expect(named?.message).not.toContain("\n");
});

test("real paginated Spaces queries remain identifiable on the app export", () => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": source(`
    const { data, page } = await spaces.task.list({ spaceId: space.id, limit: 50 });
    if (page?.hasMore) await spaces.task.list({ spaceId: space.id, limit: 50, cursor: page.nextCursor });
    console.log(data.length);
  `),
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions).toContainEqual(expect.objectContaining({ operation: "spaces.task.list", target: null }));
});

test("object-shaped values do not make an unresolved call identifiable", () => {
  const result = analyzeCode({
    sdk,
    aiOperations: [],
    entry: "code.ts",
    files: {
      "code.ts": source(`
    const h = { type: "spaces.space" as const, id: "Spc001", task: JSON.parse("{}") };
    await h.task.update({ itemId: "Itm001" });
  `),
    },
  });
  expect(result.diagnostics.some((d) => d.code === "code_unresolved_call")).toBe(true);
});
