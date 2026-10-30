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

test("the repository guard includes root tests and PWA workspaces", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "platform-clients-guard-"));
  const paths = ["tests/client.test.ts", "pwas/example/server/data.ts"];
  try {
    for (const path of paths) {
      const file = join(workspaceRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'import { sql } from "bun";');
    }
    const findings = await rule.run({ workspaceRoot, fix: false, flags: new Set() });
    expect(findings.map(({ file }) => file).sort()).toEqual(paths.map((path) => join(workspaceRoot, path)).sort());
    expect(findings.every(({ message }) => message.includes("@k2b/cloud"))).toBe(true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
