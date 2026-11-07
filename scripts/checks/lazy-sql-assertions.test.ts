import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkSource, rule } from "./lazy-sql-assertions";

test.each([
  'await expect(sql`DELETE FROM items`).rejects.toThrow("constraint");',
  'expect(tx`INSERT INTO items VALUES (${id})`).rejects.toMatchObject({ errno: "23505" });',
  "await expect(sql<{ id: string }[]>`SELECT id FROM items`).resolves.toEqual([]);",
  "expect((sql`DELETE FROM items` as Promise<unknown>)).not.rejects.toThrow();",
  "expect((tx`SELECT 1`)!).resolves.toBeDefined();",
  "expect((query = sql`DELETE FROM items`)).rejects.toThrow();",
  "expect((log(), tx`DELETE FROM items`)).rejects.toThrow();",
  "const query = sql`DELETE FROM items`, assertion = expect(query).rejects.toThrow();",
  "const query = tx`SELECT 1`, alias = query, assertion = expect(alias).resolves.toBeDefined();",
])("rejects a lazy SQL query: %s", (source) => {
  const found = checkSource("query.test.ts", source);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ file: "query.test.ts", line: 1 });
  expect(found[0]?.message).toContain(".execute()");
});

test.each([
  "expect(await sql`SELECT 1`).toHaveLength(1);",
  "expect(await sql`SELECT 1`).resolves.toBeDefined();",
  "await expect(sql`DELETE FROM items`.execute()).rejects.toThrow();",
  "await expect((tx`DELETE FROM items`).execute()).rejects.toThrow();",
  "await expect(async () => { await sql`DELETE FROM items`; }).rejects.toThrow();",
  "await expect((async () => await tx`DELETE FROM items`)()).rejects.toThrow();",
  "await expect(Promise.resolve(sql`DELETE FROM items`)).rejects.toThrow();",
  "await expect(sql.begin(async (tx) => { await tx`DELETE FROM items`; })).rejects.toThrow();",
  "expect(sql`SELECT 1`).toBeDefined();",
  "expect(other`SELECT 1`).resolves.toBeDefined();",
  "var query = query, assertion = expect(query).rejects.toThrow();",
  "const query = sql`SELECT 1`.execute(), assertion = expect(query).resolves.toBeDefined();",
  "const query = await tx`SELECT 1`, assertion = expect(query).resolves.toBeDefined();",
  "const query = sql`SELECT 1`, started = query.execute(), assertion = expect(query).resolves.toBeDefined();",
  "const query = sql`SELECT 1`, started = await query, assertion = expect(query).resolves.toBeDefined();",
  "const query = sql`SELECT 1`, alias = query, started = query.execute(), assertion = expect(alias).resolves.toBeDefined();",
  "const query = sql`SELECT 1`, assertion = (() => { const query = read(); return expect(query).resolves.toBeDefined(); })();",
  "const query = sql`SELECT 1`, assertion = ((query) => expect(query).resolves.toBeDefined())(read());",
  "// expect(sql`DELETE FROM items`).rejects.toThrow();",
  'const example = "expect(tx`DELETE FROM items`).rejects.toThrow()";',
  "const example = `expect(sql\\`DELETE FROM items\\`).rejects.toThrow()`;",
])("allows executed queries and unrelated assertions: %s", (source) => {
  expect(checkSource("query.test.ts", source)).toEqual([]);
});

test("reports multiline and optional matcher chains at the matcher line", () => {
  const source = [
    "await expect(",
    "  sql`DELETE FROM items WHERE id = ${read({ value: `nested )` })}`",
    ") /* comment */ ?.rejects.toThrow();",
    "expect((tx`SELECT 1` satisfies Query)).resolves.toBeDefined();",
  ].join("\r\n");
  expect(checkSource("query.spec.tsx", source).map(({ line }) => line)).toEqual([3, 4]);
});

test("scans test and spec files while excluding ordinary sources and generated directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-lazy-sql-assertions-"));
  try {
    const source = "await expect(sql`DELETE FROM items`).rejects.toThrow();";
    const paths = [
      "packages/demo/query.integration.test.ts",
      "scripts/query.test.ts",
      "tests/query.spec.tsx",
      "src/query.ts",
      ...["node_modules", "dist", "build", "_ssr", ".local"].map((dir) => `${dir}/query.test.ts`),
    ];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(found.map(({ file, line }) => `${relative(root, file!)}:${line}`)).toEqual([
      "packages/demo/query.integration.test.ts:1",
      "scripts/query.test.ts:1",
      "tests/query.spec.tsx:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
