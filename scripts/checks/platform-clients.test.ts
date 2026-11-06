import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkSource, rule } from "./platform-clients";

const path = "packages/example/src/data.ts";
test.each([
  'import { sql } from "bun";',
  'import { redis as cache, type SQL } from "bun";',
  'import * as native from "bun"; const db = native.sql;',
  'const cache = Bun["redis"];',
  "const { sql: db } = Bun;",
  'export { sql as db } from "bun";',
])("rejects Bun client value access: %s", (source) => {
  expect(checkSource(path, source)).toHaveLength(1);
  expect(checkSource(path, source)[0]?.message).toContain("@k2b/cloud");
});

test.each([
  "new SQL({ max: 1 });",
  'import { SQL as Pool } from "bun"; new Pool();',
  'import * as native from "bun"; new native.RedisClient(url);',
  "new Bun.SQL();",
])("rejects owned native pools: %s", (source) => {
  expect(checkSource(path, source)).toHaveLength(1);
  expect(checkSource(path, source)[0]?.message).toContain("createSql");
});

test.each([
  "env.DATABASE_URL",
  'env["REDIS_URL"]',
  "process.env.VALKEY_URL",
  "Bun.env.APP_SECRET",
  'import { env as config } from "@k2b/cloud/config"; config.NATS_SERVERS',
  "const { SYNC_NAMESPACE: namespace } = env;",
  "env.SYNC_REPLICAS",
  "env.NATS_CREDS_FILE",
  "env.NATS_TLS_CA_FILE",
  "env.NATS_IGNORE_CLUSTER_UPDATES",
])("rejects delivered environment reads: %s", (source) => {
  expect(checkSource(path, source)).toHaveLength(1);
  expect(checkSource(path, source)[0]?.message).toContain("connections()");
});

test.each([
  'import type { sql, redis, SQL } from "bun";',
  'import { type redis, type SQL, file } from "bun";',
  'import { sql, createSql, connections } from "@k2b/cloud";',
  '// Bun.sql and new SQL() are documented here\nconst example = "env.APP_SECRET";',
  "process.env.DATABASE_URL = fixtureUrl;",
  "env.APP_ID",
])("allows types, platform clients, unrelated configuration and comments: %s", (source) => expect(checkSource(path, source)).toEqual([]));

test("native constructors and target reads are allowed in test fixtures and the handle module", () => {
  expect(checkSource("packages/example/test/worker.ts", "new SQL(process.env.DATABASE_URL)")).toEqual([]);
  expect(checkSource("packages/cloud/src/runtime/clients.ts", "new SQL(options)")).toEqual([]);
  expect(checkSource("packages/cloud/src/runtime/resolve-connections.ts", "env.DATABASE_URL")).toEqual([]);
  expect(checkSource("packages/example/src/data.test.ts", 'import { sql } from "bun";')).toHaveLength(1);
});

test("the repository guard includes root tests and skips standalone PWA services", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "platform-clients-guard-"));
  const paths = ["tests/client.test.ts", "pwas/example/server/data.ts"];
  try {
    for (const path of paths) {
      const file = join(workspaceRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'import { sql } from "bun";');
    }
    const findings = await rule.run({ workspaceRoot, fix: false, flags: new Set() });
    expect(findings.map(({ file }) => file)).toEqual([join(workspaceRoot, "tests/client.test.ts")]);
    expect(findings.every(({ message }) => message.includes("@k2b/cloud"))).toBe(true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

const bunModule = JSON.stringify("bun");
test.each([
  `const db = (await import(${bunModule})).sql;`,
  'const db = require("bun")["sql"];',
  "const cache = globalThis.Bun.redis;",
  `const { sql } = await import(${bunModule});`,
  'const { redis } = require("bun");',
  `const native = await import(${bunModule}); native.sql;`,
  'const native = require("bun"); native.redis;',
  "const native = Bun; native.sql;",
  "const native = globalThis.Bun; native.redis;",
  "const native = Bun; const alias = native; alias.sql;",
  "let native; native = Bun; native.sql;",
  'const { ["sql"]: db } = Bun;',
  "const { [`redis`]: cache } = Bun;",
  'const native = Bun; const { ["sql"]: db } = native;',
  "const native = Bun; native[`sql`];",
  'import native from "bun"; const alias = native; alias.sql;',
  'import * as native from "bun"; const alias = native; alias.redis;',
  `let native; native = await import(${bunModule}); native.sql;`,
  `const { ["sql"]: db } = await import(${bunModule});`,
])("rejects alternate Bun client access: %s", (source) => {
  expect(checkSource(path, source)).toHaveLength(1);
});

test("deletion and assignment only write; nullish assignment also reads the previous value", () => {
  expect(checkSource(path, 'delete process.env.DATABASE_URL; process.env.APP_SECRET = "fixture";')).toEqual([]);
  expect(checkSource(path, "process.env.DATABASE_URL ??= fallback;")).toHaveLength(1);
});

test.each([
  "tests/integration.ts",
  "scripts/fixtures/setup.ts",
  "packages/example/test/setup.ts",
  "packages/example/bench/run.ts",
  "packages/example/src/data.test.ts",
  "packages/example/src/View.test.tsx",
  "packages/cloud/scripts/platform-start.test-fixture.ts",
  "scripts/scale-acceptance.ts",
])("known test targets allow native pools and target reads: %s", (file) => {
  expect(checkSource(file, "new SQL(process.env.DATABASE_URL)")).toEqual([]);
});

test.each([
  "packages/example/src/fixtures/data.ts",
  "packages/example/src/tests/data.ts",
  "packages/example/src/test/data.ts",
  "packages/example/src/bench/data.ts",
  "packages/example/src/new.test-fixture.ts",
  "packages/example/tests/data.ts",
  "fixtures/setup.ts",
  "test/setup.ts",
  "bench/run.ts",
])("directory names do not exempt production code: %s", (file) => {
  expect(checkSource(file, "new SQL(process.env.DATABASE_URL)")).toHaveLength(2);
});

test.each([
  "const { SQL: Pool } = Bun; new Pool();",
  'const { ["RedisClient"]: Cache } = Bun; new Cache();',
  'import { SQL } from "bun"; const Pool = SQL; new Pool();',
  'import { RedisClient as Cache } from "bun"; const Pool = Cache; new Pool();',
  "Reflect.construct(Bun.SQL, []);",
  'import { SQL } from "bun"; class Pool extends SQL {}',
  "class Pool extends Bun.SQL {}",
  'Reflect.construct(Bun["SQL"], []);',
  "const native = Bun; const { SQL: Pool } = native; new Pool();",
  'import { SQL } from "bun"; Reflect.construct(SQL, []);',
  'import { SQL } from "bun"; new Wrapper(SQL);',
  'import { SQL } from "bun"; const value = { SQL };',
  'import { SQL } from "bun"; export { SQL as Pool };',
  'const native = require("bun"); Reflect.construct(native.RedisClient, []);',
  "const Pool = Bun.SQL; new Pool();",
  'export { SQL as Pool } from "bun";',
])("rejects native constructor value escapes: %s", (source) => {
  expect(checkSource(path, source)).toHaveLength(1);
  expect(checkSource(path, source)[0]?.message).toContain("createSql");
});

test.each([
  "type Pool = Bun.SQL; type Factory = typeof Bun.SQL;",
  'import { SQL } from "bun"; interface Pool extends SQL {}',
  'import { SQL } from "bun"; class Pool implements SQL {}',
  'import { SQL } from "bun"; let pool: SQL; type Options = SQL.Options;',
  'import type { SQL as Pool } from "bun"; let pool: Pool;',
  'export { type SQL } from "bun";',
  'import { SQL } from "bun"; export type { SQL };',
  'import { SQL } from "bun"; const label = { SQL: "SQL" };',
  'const { file } = Bun; const label = { SQL: "SQL" };',
])("constructor types and unrelated properties stay allowed: %s", (source) => {
  expect(checkSource(path, source)).toEqual([]);
});

test.each(["packages/cloud/src/runtime/clients.ts", "packages/example/test/native.ts"])(
  "constructor value access stays available to native owners: %s",
  (file) => {
    expect(
      checkSource(file, 'import { SQL } from "bun"; const Pool = SQL; const { RedisClient: Cache } = Bun; Reflect.construct(Bun.SQL, []);'),
    ).toEqual([]);
  },
);

// Inspecting a native error class cannot create a pool or bypass its target.
test("allows native Postgres error classification without allowing constructor escapes", () => {
  expect(checkSource(path, 'import { SQL as Pool } from "bun"; error instanceof Pool.PostgresError;')).toEqual([]);
  expect(checkSource(path, 'import { RedisClient as Pool } from "bun"; const create = Pool.PostgresError;')).toHaveLength(1);
  expect(checkSource(path, 'import { SQL as Pool } from "bun"; new Pool();')).toHaveLength(1);
});

test.each([
  ["scripts/prod-upgrade-preflight.ts", "process.env.SYNC_NAMESPACE"],
  ["packages/cloud/scripts/sync-recovery-smoke.ts", "env.NATS_SERVERS; env.SYNC_REPLICAS"],
])("connection-only operator tools can read their inputs but cannot construct clients: %s", (file, source) => {
  expect(checkSource(file, source)).toEqual([]);
  expect(checkSource(file, "process.env.DATABASE_URL")).toHaveLength(1);
  expect(checkSource(file, 'import { SQL } from "bun"; new SQL();')).toHaveLength(1);
  expect(checkSource(file, 'import { sql } from "bun";')).toHaveLength(1);
});
