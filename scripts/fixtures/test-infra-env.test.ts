import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../workspace";
import {
  applyTestRuntimeEnv,
  dotenvLeak,
  expandTestDatabaseUrl,
  infraMappings,
  noEnvFile,
  readTestTarget,
  testRuntimeEnv,
} from "./test-infra-env";

describe("checkout test database", () => {
  test("expands the database target and every runtime alias to the same checkout database", () => {
    const env = { CLOUD_TEST_DATABASE_URL: " postgres://user:pass@localhost:5432/cloud_{checkout}_test " };
    const target = readTestTarget(env, "database");
    expect(target).toMatch(/^postgres:\/\/user:pass@localhost:5432\/cloud_[a-z0-9_]+_test$/);
    expect(target).toBe(expandTestDatabaseUrl(env.CLOUD_TEST_DATABASE_URL.trim(), workspaceRoot));
    const runtime = testRuntimeEnv(env);
    expect(runtime.DATABASE_URL).toBe(target);
    expect(runtime.POSTGRES_URL).toBe(target);
    expect(runtime.PGURL).toBe(target);
  });

  test("uses the checkout directory name and preserves connection options", () => {
    expect(
      expandTestDatabaseUrl("postgres://user:p%40ss@localhost:5432/cloud_{checkout}_test?sslmode=require#tag", "/repos/Feature-843"),
    ).toBe("postgres://user:p%40ss@localhost:5432/cloud_feature_843_test?sslmode=require#tag");
  });

  test("lowercases, collapses punctuation, and trims separators", () => {
    expect(expandTestDatabaseUrl("postgres://localhost/cloud_{checkout}_test", "/repos/__Feature .. X--Ä 2___")).toBe(
      "postgres://localhost/cloud_feature_x_2_test",
    );
    expect(expandTestDatabaseUrl("postgres://localhost/cloud_{checkout}_test", "/repos/---")).toBe(
      "postgres://localhost/cloud_checkout_test",
    );
  });

  test("caps the full database identifier while preserving the template and _test suffix", () => {
    const template = "postgres://localhost/cloud_{checkout}_test";
    const root = `/repos/${"a".repeat(100)}`;
    const expanded = expandTestDatabaseUrl(template, root);
    expect(new URL(expanded).pathname.slice(1)).toBe(`cloud_${"a".repeat(52)}_test`);
    expect(expandTestDatabaseUrl(template, root)).toBe(expanded);
    expect(expandTestDatabaseUrl(expanded, root)).toBe(expanded);
    expect(new URL(expandTestDatabaseUrl(template, `/repos/${"a".repeat(51)}--branch`)).pathname.slice(1)).toBe(
      `cloud_${"a".repeat(51)}_test`,
    );
  });

  test("budgets for every placeholder and UTF-8 bytes in the fixed name", () => {
    const root = `/repos/${"a".repeat(100)}`;
    const name = decodeURIComponent(
      new URL(expandTestDatabaseUrl("postgres://localhost/ä_{checkout}_{checkout}_test", root)).pathname.slice(1),
    );
    expect(name).toBe(`ä_${"a".repeat(27)}_${"a".repeat(27)}_test`);
    expect(Buffer.byteLength(name)).toBe(63);
    expect(() => expandTestDatabaseUrl(`postgres://localhost/${"x".repeat(58)}{checkout}_test`, root)).toThrow("63-byte");
  });

  test("keeps percent-encoded characters in the database name encoded", () => {
    expect(expandTestDatabaseUrl("postgres://localhost/cloud_%25_{checkout}_test", "/repos/branch")).toBe(
      "postgres://localhost/cloud_%25_branch_test",
    );
    const expanded = expandTestDatabaseUrl("postgres://localhost/cloud_%2520_{checkout}_test", "/repos/branch");
    expect(decodeURIComponent(new URL(expanded).pathname.slice(1))).toBe("cloud_%20_branch_test");
  });

  test("does not expand placeholders in credentials or query parameters", () => {
    const target = "postgres://{checkout}:pass@localhost/cloud_test?application_name={checkout}";
    expect(expandTestDatabaseUrl(target, "/repos/branch")).toBe(target);
  });

  test("keeps application_name on an alias already bound to the expanded database", () => {
    const template = "postgres://localhost/cloud_{checkout}_test";
    const expanded = expandTestDatabaseUrl(template);
    const named = `${expanded}?application_name=worker`;
    expect(testRuntimeEnv({ CLOUD_TEST_DATABASE_URL: template, DATABASE_URL: named }).DATABASE_URL).toBe(named);
  });

  test("leaves targets without a database placeholder unchanged", () => {
    const target = "postgres://user:pass@localhost:5432/cloud_test?application_name=runner";
    expect(readTestTarget({ CLOUD_TEST_DATABASE_URL: ` ${target} ` }, "database")).toBe(target);
    expect(readTestTarget({ CLOUD_TEST_DATABASE_URL: " " }, "database")).toBeUndefined();
    const other = "https://localhost/{checkout}";
    expect(readTestTarget({ CLOUD_TEST_FILEGATE_URL: other }, "filegate")).toBe(other);
  });
});

describe("test runtime aliases", () => {
  test("map every configured CLOUD_TEST_* target to its runtime variables", () => {
    const env = testRuntimeEnv({
      CLOUD_TEST_VALKEY_URL: " redis://127.0.0.1:57001 ",
      CLOUD_TEST_NATS_SERVERS: "nats://127.0.0.1:4222,nats://127.0.0.1:4223",
    });
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:57001");
    expect(env.VALKEY_URL).toBe("redis://127.0.0.1:57001");
    expect(env.NATS_SERVERS).toBe("nats://127.0.0.1:4222,nats://127.0.0.1:4223");
    expect(env.SYNC_TEST_SERVERS).toBe(env.NATS_SERVERS);
  });

  test("map a missing or blank Postgres or Valkey target to a closed loopback port", () => {
    const env = testRuntimeEnv({ CLOUD_TEST_DATABASE_URL: "  ", REDIS_URL: "redis://localhost:6379" });
    expect(env.DATABASE_URL).toBe("postgres://127.0.0.1:1/unset");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:1");
    expect(env.VALKEY_URL).toBe("redis://127.0.0.1:1");
  });

  test("keep the application_name a test gives a process it starts against the test database", () => {
    const target = "postgres://cloud:secret@127.0.0.1:5432/cloud_test";
    const named = `${target}?application_name=grids-crash%3Arun`;
    const env = testRuntimeEnv({ CLOUD_TEST_DATABASE_URL: target, DATABASE_URL: named, POSTGRES_URL: target });
    expect(env.DATABASE_URL).toBe(named);
    expect(env.POSTGRES_URL).toBe(target);
    expect(env.PGURL).toBe(target);
    for (const other of [
      "postgres://cloud:secret@127.0.0.1:5432/cloud?application_name=grids-crash%3Arun",
      "postgres://cloud:secret@127.0.0.1:5433/cloud_test?application_name=grids-crash%3Arun",
      `${named}&options=-c%20search_path%3Dother`,
    ]) {
      expect(testRuntimeEnv({ CLOUD_TEST_DATABASE_URL: target, DATABASE_URL: other }).DATABASE_URL).toBe(target);
    }
  });

  test("remove every other alias whose target is missing, because unset means off", () => {
    const env: Record<string, string | undefined> = {
      CLOUD_TEST_VALKEY_URL: "redis://127.0.0.1:57001",
      NATS_SERVERS: "nats://localhost:4222",
      GOTENBERG_URL: "http://localhost:3001",
    };
    applyTestRuntimeEnv(env);
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:57001");
    expect(env.DATABASE_URL).toBe("postgres://127.0.0.1:1/unset");
    for (const [kind, mapping] of Object.entries(infraMappings)) {
      if (kind === "database" || kind === "valkey") continue;
      for (const runtime of mapping.runtime) expect(env).not.toHaveProperty(runtime);
    }
  });

  test("take the NATS identity only from CLOUD_TEST_NATS_CREDS_FILE", () => {
    const inherited: Record<string, string | undefined> = { NATS_CREDS_FILE: "/run/secrets/installation.creds" };
    applyTestRuntimeEnv(inherited);
    expect(inherited).not.toHaveProperty("NATS_CREDS_FILE");
    expect(testRuntimeEnv({ CLOUD_TEST_NATS_CREDS_FILE: " /cloud/.local/nats/test.creds " }).NATS_CREDS_FILE).toBe(
      "/cloud/.local/nats/test.creds",
    );
    expect(() => testRuntimeEnv({ CLOUD_TEST_NATS_CREDS_FILE: ".local/nats/test.creds" })).toThrow("must be an absolute path");
  });
});

describe("dotenv leak", () => {
  test("names a checkout's .env unless Bun started with --no-env-file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cloud-dotenv-"));
    try {
      expect(dotenvLeak(cwd, [])).toBeUndefined();
      await writeFile(join(cwd, ".env"), "APP_URL=https://example.invalid\n");
      expect(dotenvLeak(cwd, [])).toBe(join(cwd, ".env"));
      expect(dotenvLeak(cwd, [noEnvFile])).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("names the mode files Bun loads, not the committed examples", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cloud-dotenv-"));
    try {
      await writeFile(join(cwd, ".env.example"), "APP_URL=\n");
      expect(dotenvLeak(cwd, [])).toBeUndefined();
      await writeFile(join(cwd, ".env.development.local"), "APP_URL=https://example.invalid\n");
      expect(dotenvLeak(cwd, [])).toBe(join(cwd, ".env.development.local"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("bun run test starts the runner without dotenv files", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as { scripts: { test: string } };
    expect(manifest.scripts.test).toBe(`bun ${noEnvFile} scripts/run-tests.ts`);
  });
});

describe("ClickHouse test gate", () => {
  test("has an explicit admin URL and no runtime aliases", () => {
    expect(infraMappings.clickhouse).toEqual({ test: "CLOUD_TEST_CLICKHOUSE_URL", runtime: [] });
    expect(readTestTarget({}, "clickhouse")).toBeUndefined();
    expect(readTestTarget({ CLOUD_TEST_CLICKHOUSE_URL: " http://fixture:fake@127.0.0.1:8123 " }, "clickhouse")).toBe(
      "http://fixture:fake@127.0.0.1:8123",
    );
    expect(Object.keys(testRuntimeEnv({ CLOUD_TEST_CLICKHOUSE_URL: "http://fixture:fake@127.0.0.1:8123" }))).not.toContain(
      "CLICKHOUSE_URL",
    );
  });
  const run = (source: string, target?: string) =>
    Bun.spawnSync([process.execPath, "--no-env-file", "-e", source], {
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH, BUN_OPTIONS: "--no-env-file", ...(target ? { CLOUD_TEST_CLICKHOUSE_URL: target } : {}) },
    });
  test("unset target skips the suite", () => {
    const result = run(
      'import { suiteFor } from "./scripts/fixtures/test-infra.ts"; import { describe } from "bun:test"; console.log(suiteFor("clickhouse") === describe.skip)',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true");
  });
  test("unreachable target fails loudly with a redacted URL, never the password", () => {
    const result = run(
      'import { requireInfra } from "./scripts/fixtures/test-infra.ts"; try { await requireInfra("clickhouse") } catch (e) { console.error(e.message); process.exit(1) }',
      "http://fixture:obviously-fake-gate-password@127.0.0.1:1",
    );
    expect(result.exitCode).toBe(1);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("CLOUD_TEST_CLICKHOUSE_URL=http://fixture:REDACTED@127.0.0.1:1/");
    expect(output).toContain("set but not usable");
    expect(output).not.toContain("obviously-fake-gate-password");
  });
  test("all target diagnostics redact URL passwords and query parameters", () => {
    const result = run(
      'import { redactTarget } from "./scripts/fixtures/test-infra.ts"; console.log(redactTarget("postgres://fixture:fake-password@localhost/cloud_test?password=fake-password"))',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("postgres://fixture:REDACTED@localhost/cloud_test\n");
  });
});
