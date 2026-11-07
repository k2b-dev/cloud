import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePackage, migrateSource } from "./platform-clients";

test("moves values and aliases while keeping Bun types and unrelated imports", () => {
  const input = 'import { sql as db, redis, type SQL, type RedisClient, file } from "bun";\nconst query = db`SELECT 1`;';
  const { source } = migrateSource(input, "packages/example/src/data.ts");
  expect(source).toContain('import { sql as db, redis } from "@k2b/cloud"');
  expect(source).toContain('import { type SQL, type RedisClient, file } from "bun"');
  expect(source).toContain("db`SELECT 1`");
  expect(migrateSource(source, "packages/example/src/data.ts").source).toBe(source);
});

test("type-only client imports are unchanged", () => {
  const input = 'import type { sql, redis, SQL } from "bun";\nimport { type sql as SqlType } from "bun";';
  expect(migrateSource(input, "packages/example/src/types.ts").source).toBe(input);
});

test("moves re-exported clients while preserving type exports", () => {
  const result = migrateSource('export { sql as db, type SQL } from "bun";', "packages/example/src/index.ts");
  expect(result.source).toContain('export { sql as db } from "@k2b/cloud"');
  expect(result.source).toContain('export { type SQL } from "bun"');
});

test("preserves executable shebangs and runtime constructor references", () => {
  const input = '#!/usr/bin/env bun\nimport { SQL, sql } from "bun";\nconst pool = new SQL(); const native = SQL;';
  const result = migrateSource(input, "packages/example/scripts/verify.ts");
  expect(result.source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  expect(result.source).toContain('import { SQL } from "bun"');
  expect(result.source).toContain("const native = SQL");
});

test("namespace and global property access use collision-free named handles", () => {
  const input = 'import * as bun from "bun";\nconst sql = "domain";\nconst a = bun.sql; const b = Bun["redis"]; bun.file("x");';
  const { source } = migrateSource(input, "packages/example/src/data.ts");
  expect(source).toContain("sql as platformSql, redis");
  expect(source).toContain("const a = platformSql; const b = redis");
  expect(source).toContain('bun.file("x")');
});

test("owned SQL pools preserve options, explicit URLs, aliases and lifecycle", () => {
  const input =
    'import { SQL as Database } from "bun";\nconst a = new Database({ max: 1, connectionTimeout: 15 });\nconst b = new Database(target, { max: 2 });\nawait a.close();';
  const result = migrateSource(input, "packages/example/src/data.ts");
  expect(result.pools).toBe(2);
  expect(result.source).toContain("createSql({ max: 1, connectionTimeout: 15 })");
  expect(result.source).toContain("createSql({ ...({ max: 2 }), url: target })");
  expect(result.source).toContain("type SQL as Database");
  expect(result.source).toContain("await a.close()");
  expect(migrateSource(result.source, "packages/example/src/data.ts").source).toBe(result.source);
});

test("owned Redis pools use the snapshot and preserve fail-fast options", () => {
  const input =
    'import { RedisClient } from "bun";\nconst client = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false, connectionTimeout: 1000 });';
  const result = migrateSource(input, "packages/example/src/cache.ts");
  expect(result.pools).toBe(1);
  expect(result.source).toContain("createRedis({ enableOfflineQueue: false, connectionTimeout: 1000 })");
  expect(result.source).toContain("type RedisClient");
  expect(migrateSource(result.source, "packages/example/src/cache.ts").source).toBe(result.source);
});

test("Cloud internals use the leaf runtime module and test constructors stay native", () => {
  expect(migrateSource('import { sql } from "bun";', "packages/cloud/src/services/example.ts").source).toContain(
    'from "../runtime/clients"',
  );
  const input = 'import { SQL, sql } from "bun"; const fixture = new SQL("sqlite://:memory:");';
  const result = migrateSource(input, "packages/cloud/src/services/example.test.ts");
  expect(result.source).toContain('new SQL("sqlite://:memory:")');
  expect(result.pools).toBe(0);
});

test("standalone Cloud examples use the public application entry point", () => {
  for (const file of ["packages/cloud/examples/app-pwa/src/domain.ts", "packages/cloud/examples/app-pwa/test/flow.integration.test.ts"]) {
    const result = migrateSource('import { sql } from "bun";', file);
    expect(result.source).toContain('from "@k2b/cloud"');
    expect(result.source).not.toContain("runtime/clients");
    expect(migrateSource(result.source, file).source).toBe(result.source);
  }
});

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
test("the package boundary rejects parent paths and escaping symlinks", () => {
  root = mkdtempSync(join(tmpdir(), "platform-clients-"));
  const pkg = join(root, "packages/example");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  const outside = join(root, "outside.ts");
  writeFileSync(outside, 'import { sql } from "bun";');
  symlinkSync(outside, join(pkg, "escape.ts"));
  expect(() => migratePackage(root!, "packages/..")).toThrow();
  expect(migratePackage(root!, "packages/example").files).toBe(0);
  expect(readFileSync(outside, "utf8")).toBe('import { sql } from "bun";');
});

test("dry-run reports counts without writing and reruns change nothing", () => {
  root = mkdtempSync(join(tmpdir(), "platform-clients-"));
  const pkg = join(root, "packages/example");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  const path = join(pkg, "data.ts");
  writeFileSync(path, 'import { sql } from "bun";');
  expect(migratePackage(root, "packages/example", true).files).toBe(1);
  expect(readFileSync(path, "utf8")).toContain('from "bun"');
  expect(migratePackage(root, "packages/example").files).toBe(1);
  expect(migratePackage(root, "packages/example").files).toBe(0);
});

test.each([
  '/** File documentation. */\nimport { sql } from "bun";\nconst query = sql`SELECT 1`;',
  "#!/usr/bin/env bun\n// File documentation.\nconst query = Bun.sql`SELECT 1`;",
])("inserts client imports after leading comments and preserves rerun output", (input) => {
  const result = migrateSource(input, "packages/example/src/data.ts");
  expect(result.source.indexOf("File documentation.")).toBeLessThan(result.source.indexOf('from "@k2b/cloud"'));
  expect(migrateSource(result.source, "packages/example/src/data.ts").source).toBe(result.source);
});

test("a moved named client is reused by namespace and global access", () => {
  const result = migrateSource('import { sql as db } from "bun"; const a = db; const b = Bun.sql;', "packages/example/src/data.ts");
  expect(result.source).toContain('import { sql as db } from "@k2b/cloud"');
  expect(result.source).toContain("const b = db");
  expect(result.source).not.toContain("platformSql");
});

test("rewritten pool arguments still migrate clients and nested constructors in one pass", () => {
  const result = migrateSource(
    'import { SQL, RedisClient, sql } from "bun"; const pool = new SQL({ nested: new SQL(), callback: () => Bun.sql, cache: new RedisClient(env.REDIS_URL) });',
    "packages/example/src/data.ts",
  );
  expect(result.pools).toBe(3);
  expect(result.source).toContain("nested: createSql(), callback: () => sql, cache: createRedis()");
  expect(result.source).not.toContain("Bun.sql");
  expect(result.source).not.toContain("sql as platformSql");
  expect(migrateSource(result.source, "packages/example/src/data.ts").source).toBe(result.source);
});

test("imports precede declaration JSDoc while keeping trailing import comments attached", () => {
  const documented = migrateSource("/** Documents foo. */\nexport const foo = Bun.sql;", "packages/example/src/data.ts").source;
  expect(documented.indexOf('from "@k2b/cloud"')).toBeLessThan(documented.indexOf("/** Documents foo. */"));
  expect(documented).toContain("/** Documents foo. */\nexport const foo");
  const trailing = migrateSource(
    'import { file } from "bun"; // keep this explanation\nconst db = Bun.sql;',
    "packages/example/src/data.ts",
  ).source;
  expect(trailing).toContain('import { file } from "bun"; // keep this explanation\nimport');
});

test("replacing the only Bun import preserves declaration JSDoc and file headers", () => {
  const input = '/** File header. */\nimport { sql } from "bun";\n\n/** Reads x. */\nexport const x = sql`SELECT 1`;';
  const result = migrateSource(input, "packages/example/src/data.ts").source;
  expect(result).toBe(input.replace('from "bun"', 'from "@k2b/cloud"'));
  expect(migrateSource(result, "packages/example/src/data.ts").source).toBe(result);
});

test.each(["bench/run.ts", "tests/setup.ts", "packages/example/bench/run.ts"])("fixture pools stay native: %s", (file) => {
  const input = 'import { SQL } from "bun"; const pool = new SQL({ max: 1 });';
  expect(migrateSource(input, file)).toEqual({ source: input, pools: 0 });
});
