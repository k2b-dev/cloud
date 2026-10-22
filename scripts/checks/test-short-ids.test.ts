import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkTestShortIdsSource, rule } from "./test-short-ids";

const file = "packages/demo/src/fixture.integration.test.ts";
const check = (source: string) => checkTestShortIdsSource(file, source);

const rejected = [
  'const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);',
  'const short_id = () => Math.random().toString(36).slice(2, 8).padEnd(6, "x");',
  "const notebookShortId = Math.random().toString(36);",
  "const identity = () => ({ shortId: Bun.randomUUIDv7().slice(-6) });",
  'const identity = { "short_id": testUuid().replace(/-/g, "").substring(0, 8) };',
  "const shortId = () => { return uuid().substr(1, 6); };",
  "const shortId = uuid().slice(-6, 20);",
  "const shortId = uuid().substring(-2, 6);",
  "const shortId = () => crypto.randomUUID().slice(0, 10);",
  "function fixture(shortId = uuid().substring(6, 0)) {}",
  "class Fixture { shortId = uuid().slice(-10, -2); }",
  'const shortId = Array.from(crypto.getRandomValues(new Uint8Array(8))).join("").slice(0, 10);',
  "sql`INSERT INTO demo (short_id) VALUES (${crypto.randomUUID().slice(0, 6)})`;",
  "sql`INSERT INTO demo (short_id) VALUES (${`a${crypto.randomUUID().slice(0, 7)}`})`;",
  "sql`INSERT INTO demo (short_id) VALUES (${Math.random().toString(36)})`;",
  `const shortId = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 6);`,
  "sql`SELECT substr(md5(random()::text), 1, 6)`;",
  "sql`SELECT left(gen_random_uuid()::text, 8)`;",
  "sql`SELECT substring(random()::text, 1, 10)`;",
];

for (const source of rejected) {
  test(`rejects ${source}`, () => {
    expect(check(source)).toEqual([
      {
        file,
        line: 1,
        message:
          "Fixture short IDs come from testShortId() in scripts/fixtures/test-short-id; a random value cut to short-ID length repeats and fails the unique index at random (#1594).",
      },
    ]);
  });
}

test("accepts service generators, deterministic IDs, and unrelated randomness", () => {
  const allowed = [
    "const shortId = testShortId();",
    "sql`INSERT INTO demo VALUES (${testShortId(10)})`;",
    "const shortId = newShortId();",
    "const shortId = crypto.common.readableId(6);",
    "const shortId = createAiShortId();",
    "sql`INSERT INTO demo VALUES (${crypto.randomUUID()})`;",
    "const shortId = crypto.randomUUID();",
    'const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);',
    "sql`INSERT INTO spans VALUES (${crypto.randomUUID().slice(0, 16)})`;",
    "const displayName = crypto.randomUUID().slice(0, 8);",
    "const user = { uid: `cli-${crypto.randomUUID().slice(0, 8)}` };",
    "const shortId = fixedValue.slice(0, 6);",
    "const shortId = uuid().slice(0, -6);",
    "const shortId = uuid().slice(6);",
    "const shortId = uuid().substring(6);",
    "const shortId = uuid().substr(6);",
    "const shortId = uuid().slice(0, 11);",
    "const shortId = uuid().slice(0, width);",
    "const shortId = 42 .toString(36);",
    'const example = "const shortId = crypto.randomUUID().slice(0, 6)";',
    "// const shortId = crypto.randomUUID().slice(0, 6);",
    "sql`SELECT left(gen_random_uuid()::text, 16)`;",
    "sql`SELECT gen_random_uuid(), random()`;",
  ];
  expect(allowed.flatMap(check)).toEqual([]);
});

test("reports the actual source line", () => {
  expect(check("\n\nconst shortId = crypto.randomUUID().slice(0, 6);").map(({ line }) => line)).toEqual([3]);
});

test("scans package test and fixture names only, without a baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-short-ids-"));
  const included = [
    "packages/demo/src/api.test.ts",
    "packages/demo/src/view.test.tsx",
    "packages/demo/src/api.integration.test.ts",
    "packages/demo/src/api.spec.ts",
    "packages/demo/src/api-fixture.ts",
    "packages/demo/src/api.test-fixture.ts",
    "packages/demo/src/test-helper.ts",
    "packages/demo/src/view.fixtures.ts",
  ];
  const excluded = [
    "scripts/fixtures/test-helper.ts",
    "docs-site/src/view.test.ts",
    "packages/demo/src/api.ts",
    "packages/demo/node_modules/dep/api.test.ts",
    "packages/demo/dist/api.test.ts",
  ];
  try {
    for (const path of [...included, ...excluded]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "const shortId = crypto.randomUUID().slice(0, 6);");
    }
    for (const fix of [false, true]) {
      const findings = await rule.run({ workspaceRoot: root, fix, flags: new Set() });
      expect(findings.map(({ file }) => file)).toEqual([...included].sort());
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
