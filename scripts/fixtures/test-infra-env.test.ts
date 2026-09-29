import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTestRuntimeEnv, dotenvLeak, infraMappings, noEnvFile, testRuntimeEnv } from "./test-infra-env";

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
