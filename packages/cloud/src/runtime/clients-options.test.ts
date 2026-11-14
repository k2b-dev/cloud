import { afterAll, expect, test } from "bun:test";
import { createSql } from "./clients";
import { connectionFixture, stubConnections } from "./connections.test-fixture";

const snapshot = stubConnections();
afterAll(() => snapshot.mockRestore());

test("rejects client URL options before Bun can turn them into Postgres startup parameters", () => {
  for (const key of [
    "max",
    "idleTimeout",
    "idle_timeout",
    "connectionTimeout",
    "connection_timeout",
    "connectTimeout",
    "connect_timeout",
    "maxLifetime",
    "max_lifetime",
    "prepare",
    "bigint",
    "onconnect",
    "onclose",
    "allowPublicKeyRetrieval",
    "adapter",
    "url",
    "host",
    "hostname",
    "port",
    "user",
    "username",
    "pass",
    "password",
    "db",
    "database",
    "connection",
    "MAX",
  ]) {
    const url = new URL("postgres://fixture:private-password@127.0.0.1:1/unused_test");
    url.searchParams.set(key, "private-option-value");
    expect(() => createSql({ url })).toThrow("SQL URL contains a client option; use createSql options or CLOUD_DATABASE_POOL_MAX");
  }
});

test("also rejects client options inherited from the installation URL", () => {
  snapshot.mockReturnValue(connectionFixture({ database: { url: "postgres://127.0.0.1:1/unused_test?max=2" } }));
  try {
    expect(() => createSql({ max: 2 })).toThrow("SQL URL contains a client option");
  } finally {
    snapshot.mockReturnValue(connectionFixture());
  }
});

test("derives native client options separately from preserved server and TLS URL parameters", async () => {
  const url = new URL("postgres://127.0.0.1:1/unused_test?application_name=operator&statement_timeout=1000&sslmode=disable");
  const before = url.toString();
  const pool = createSql({ url, max: 2, idle_timeout: 3, connect_timeout: 4, max_lifetime: 5, prepare: false, bigint: true });
  try {
    expect(pool.options).toMatchObject({
      max: 2,
      idleTimeout: 3000,
      connectionTimeout: 4000,
      maxLifetime: 5000,
      prepare: false,
      bigint: true,
    });
    expect(url.toString()).toBe(before);
  } finally {
    await pool.close();
  }
});
