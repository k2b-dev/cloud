import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./test-sync-namespaces";

const fixtureImport = 'import { testSyncNamespace } from "../../../scripts/fixtures/test-infra";\n';

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-sync-namespaces-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/example"] } }));
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts test Sync namespaces taken from testSyncNamespace()", async () => {
  expect(
    await findings({
      "packages/example/src/inline.integration.test.ts": `${fixtureImport}createSync({ connection, namespace: testSyncNamespace("inline") });\n`,
      "packages/example/src/const.integration.test.ts": `${fixtureImport}const namespace = testSyncNamespace("const");\nconst sync = createSync({ connection, namespace, application: "example" });\n`,
      "packages/example/src/helper.ts": `${fixtureImport}export const start = (namespace = testSyncNamespace("helper")) =>\n  createSync({ connection, namespace });\n`,
      "tests/integration/root.integration.test.ts": `createSync({\n  connection,\n  namespace: testSyncNamespace(\`root-\${label}\`),\n});\n`,
    }),
  ).toEqual([]);
});

test("reports test code whose Sync namespace escapes the fixture's cleanup", async () => {
  expect(
    (
      await findings({
        "packages/example/src/literal.integration.test.ts":
          "const sync = createSync({ connection, namespace: `example-events-${crypto.randomUUID()}` });\n",
        "packages/example/src/prefixed.test.ts":
          "const namespace = `test-example-${crypto.randomUUID()}`;\n\ncreateSync({ connection, namespace });\n",
        "packages/example/src/argument.test.ts": "export const start = (namespace: string) => createSync({ connection, namespace });\n",
        "packages/example/src/helper.ts": `${fixtureImport}createSync({ connection, namespace: "example" });\n`,
      })
    ).sort(),
  ).toEqual([
    "packages/example/src/argument.test.ts:1",
    "packages/example/src/helper.ts:2",
    "packages/example/src/literal.integration.test.ts:1",
    "packages/example/src/prefixed.test.ts:3",
  ]);
});

test("leaves application code alone", async () => {
  expect(
    await findings({
      "packages/example/src/runtime.ts": 'createSync({ connection, namespace: env.SYNC_NAMESPACE, application: "example" });\n',
    }),
  ).toEqual([]);
});
