import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSqlJsonbTextSource, rule } from "./sql-jsonb-text";

const check = (source: string) => checkSqlJsonbTextSource("fixture.ts", source);
for (const source of [
  'sql`SELECT ${JSON.stringify({ binding: { hash: "x" } })}::jsonb`;',
  "const text = JSON.stringify(value); const alias = text; db`SELECT ${alias}::jsonb`;",
  "db`SELECT ${JSON.stringify(value)}::json`;",
  "db`SELECT CAST(${JSON.stringify(value)} AS jsonb)`;",
  "db`SELECT CAST( (${JSON.stringify(value)}) AS json)`;",
  "function write(text: string) { return db`SELECT ${text}::jsonb`; }",
  "db`SELECT ${value === null ? null : JSON.stringify(value)}::jsonb`;",
  'db`SELECT ${"{}"} :: pg_catalog.jsonb`;',
  "db`SELECT ( ${JSON.stringify(value)} /* text */ ) :: jsonb`;",
  "db`SELECT ${JSON . stringify(value)} -- cast\n ::jsonb`;",
  "db`SELECT ${JSON.stringify(\n { nested: { value: true } }\n)}\n::jsonb`;",
])
  test(`rejects unsafe JSONB: ${source}`, () => expect(check(source)).toHaveLength(1));

test("checks JSON casts after TypeScript generic arrows", () => {
  const source = [
    "const operation = async <T>(change: () => Promise<T>) => change();",
    "const payload = JSON.stringify({ name: 'Chat' });",
    "db`SELECT ${payload}::jsonb`;",
    "db`SELECT ${JSON.stringify({ panels: [] })}::jsonb`;",
  ].join("\n");
  expect(check(source).map(({ line }) => line)).toEqual([3, 4]);
  expect(check(source.replaceAll("::jsonb", "::text::jsonb"))).toEqual([]);
});

test("accepts explicit text casts, objects, literal SQL and examples", () => {
  expect(
    check(
      [
        "db`SELECT ${JSON.stringify(value)}::text::jsonb, ${{ a: 1 }}::jsonb, ${null}::jsonb`;",
        "db`SELECT '{}'::jsonb`;",
        'db`SELECT jsonb_build_object(${"key"})::jsonb`;',
        "db`SELECT CAST(${JSON.stringify(value)}::text AS jsonb)`;",
        "db`SELECT to_jsonb(${JSON.stringify(value)}::text)`;",
        "const object = { a: 1 }; db`SELECT ${object}::jsonb`;",
        'const text = "{}"; function f(text: { a: number }) { return db`SELECT ${text}::jsonb`; }',
        "// db`SELECT ${JSON.stringify(value)}::jsonb`;",
        'const example = "db`SELECT ${JSON.stringify(value)}::jsonb`";',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("repository rule catches a deliberately wrong fixture without baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-sql-jsonb-"));
  try {
    await mkdir(join(root, "packages/demo"), { recursive: true });
    await writeFile(join(root, "packages/demo/wrong.ts"), '\nconst text: string = "{}";\nsql`SELECT ${text}::jsonb`;');
    expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toMatchObject([
      { file: "packages/demo/wrong.ts", line: 3 },
    ]);
  } finally {
    await rm(join(root, "packages/demo/wrong.ts"));
    await rmdir(join(root, "packages/demo"));
    await rmdir(join(root, "packages"));
    await rmdir(root);
  }
});
