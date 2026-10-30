import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionFixture } from "./connections.test-fixture";
import { resolveConnections } from "./resolve-connections";

const keys = [
  "DATABASE_URL",
  "DATABASEURL",
  "TLS_DATABASE_URL",
  "POSTGRES_URL",
  "PGURL",
  "PG_URL",
  "TLS_POSTGRES_DATABASE_URL",
  "DATABASE_URL_FILE",
  "REDIS_URL",
  "REDIS_URL_FILE",
  "VALKEY_URL",
  "NATS_SERVERS",
  "SYNC_NAMESPACE",
  "SYNC_REPLICAS",
  "NATS_IGNORE_CLUSTER_UPDATES",
  "NATS_CREDS_FILE",
  "NATS_TLS_CA_FILE",
  "APP_SECRET",
  "APP_SECRET_FILE",
];
let previous: Record<string, string | undefined>;
const dirs: string[] = [];
beforeEach(() => {
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DATABASE_URL = "postgres://fixture:fixture@localhost/fixture_test";
  process.env.REDIS_URL = "redis://localhost:6380";
});
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
const file = (contents: string) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-connections-"));
  dirs.push(dir);
  const path = join(dir, "secret");
  writeFileSync(path, contents);
  return path;
};
const core = () =>
  connectionFixture({
    database: { url: "postgres://core/core_test" },
    valkey: { url: "redis://core:6379" },
    nats: {
      servers: ["nats://core:4222"],
      namespace: "core-namespace",
      replicas: 5,
      ignoreClusterUpdates: false,
      creds: "core-credentials",
      ca: "core-ca",
    },
    appSecret: { current: "core-secret" },
  });

describe("platform connection resolution", () => {
  test("pure env mode preserves defaults without inventing a database or Valkey target", () => {
    const resolved = resolveConnections({ appId: "inventory" });
    expect(resolved.nats).toMatchObject({ servers: [], namespace: "", replicas: 3, ignoreClusterUpdates: true });
    expect(resolved.sources.database.url).toBe("env");
    delete process.env.DATABASE_URL;
    expect(() => resolveConnections({ appId: "inventory" })).toThrow("DATABASE_URL is required for platform start");
    process.env.DATABASE_URL = "postgres://localhost/fixture_test";
    delete process.env.REDIS_URL;
    expect(() => resolveConnections({ appId: "inventory" })).toThrow("REDIS_URL is required for platform start");
  });
  test("Core values beat defaults, while explicit env and false win independently", () => {
    process.env.NATS_IGNORE_CLUSTER_UPDATES = "false";
    process.env.SYNC_REPLICAS = "1";
    const supplied = core();
    supplied.nats.ignoreClusterUpdates = true;
    const resolved = resolveConnections({ appId: "inventory", core: supplied });
    expect(resolved.database.url).toBe(process.env.DATABASE_URL!);
    expect(resolved.nats).toMatchObject({
      servers: ["nats://core:4222"],
      namespace: "core-namespace",
      replicas: 1,
      ignoreClusterUpdates: false,
    });
    expect(resolved.appSecret.current).toBe("core-secret");
    expect(resolved.sources.nats).toMatchObject({ servers: "core", namespace: "core", replicas: "env", ignoreClusterUpdates: "env" });
    delete process.env.NATS_IGNORE_CLUSTER_UPDATES;
    delete process.env.SYNC_REPLICAS;
    expect(resolveConnections({ appId: "inventory", core: core() }).nats).toMatchObject({ replicas: 5, ignoreClusterUpdates: false });
  });
  test("empty canonical values fall through to aliases and Core, never to key-mode defaults", () => {
    process.env.REDIS_URL = " \n";
    process.env.VALKEY_URL = "rediss://alias:6380";
    process.env.APP_SECRET = " ";
    process.env.NATS_SERVERS = "";
    const resolved = resolveConnections({ appId: "inventory", core: core() });
    expect(resolved.valkey.url).toBe("rediss://alias:6380");
    expect(resolved.sources.valkey.url).toBe("env");
    expect(resolved.appSecret.current).toBe("core-secret");
    const missing = core();
    missing.nats.namespace = "";
    expect(() => resolveConnections({ appId: "inventory", core: missing })).toThrow("SYNC_NAMESPACE is required");
  });
  test("canonical values win over aliases and empty secret files fall through to Core", () => {
    process.env.VALKEY_URL = "redis://alias:6380";
    process.env.APP_SECRET_FILE = file("\n");
    const resolved = resolveConnections({ appId: "inventory", core: core() });
    expect(resolved.valkey.url).toBe(process.env.REDIS_URL!);
    expect(resolved.appSecret.current).toBe("core-secret");
    expect(resolved.sources.appSecret.current).toBe("core");
  });
  test("secret files preserve content semantics and reject conflicts without exposing values", () => {
    process.env.APP_SECRET_FILE = file("mounted-secret\n");
    const resolved = resolveConnections({ appId: "inventory", core: core() });
    expect(resolved.appSecret.current).toBe("mounted-secret");
    expect(resolved.sources.appSecret.current).toBe("env");
    process.env.APP_SECRET = "do-not-print";
    expect(() => resolveConnections({ appId: "inventory" })).toThrow("APP_SECRET and APP_SECRET_FILE must not both be set");
  });
  test("accepts native socket URLs, Valkey schemes, bare NATS hosts and Postgres aliases", () => {
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_URL = "postgres:///fixture_test?host=/run/postgresql";
    process.env.REDIS_URL = "valkey://localhost:6380";
    process.env.NATS_SERVERS = "localhost:4222";
    const resolved = resolveConnections({ appId: "inventory", core: core() });
    expect(resolved.database.url).toBe(process.env.POSTGRES_URL!);
    expect(resolved.sources.database.url).toBe("env");
    expect(resolved.valkey.url).toBe(process.env.REDIS_URL!);
    expect(resolved.nats.servers).toEqual(["localhost:4222"]);
  });
  test("an explicit current secret replaces the entire Core rotation set", () => {
    const supplied = core();
    supplied.appSecret = { current: "core", previous: "old", next: "new" };
    process.env.APP_SECRET = "pinned";
    const resolved = resolveConnections({ appId: "inventory", core: supplied });
    expect(resolved.appSecret).toEqual({ current: "pinned" });
    expect(resolved.sources.appSecret).toEqual({ current: "env" });
  });
  test("reads NATS file contents at start and retains an immutable input snapshot", () => {
    process.env.NATS_CREDS_FILE = file("fixture-credentials\n");
    process.env.NATS_TLS_CA_FILE = file("fixture-ca\n");
    const resolved = resolveConnections({ appId: "inventory" });
    writeFileSync(process.env.NATS_CREDS_FILE, "changed");
    process.env.REDIS_URL = "redis://changed:6380";
    expect(resolved.nats.creds).toBe("fixture-credentials\n");
    expect(resolved.nats.ca).toBe("fixture-ca\n");
    expect(resolved.valkey.url).toBe("redis://localhost:6380");
  });
  test("invalid explicit values never fall back to Core and errors never print credentials", () => {
    for (const [key, value, error] of [
      ["DATABASE_URL", "not a URL do-not-print", "DATABASE_URL must be a valid URL"],
      ["REDIS_URL", "not a URL do-not-print", "REDIS_URL must be a valid URL"],
      ["NATS_SERVERS", "nats://ok:4222,nats://do-not-print@", "NATS_SERVERS must be a valid URL or host:port"],
      ["SYNC_REPLICAS", "2", "SYNC_REPLICAS must be 1, 3, or 5"],
    ]) {
      const previous = process.env[key!];
      process.env[key!] = value;
      expect(() => resolveConnections({ appId: "inventory", core: core() })).toThrow(error);
      if (previous === undefined) delete process.env[key!];
      else process.env[key!] = previous;
    }
  });
});
