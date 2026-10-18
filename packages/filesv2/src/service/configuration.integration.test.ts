import { afterAll, beforeAll, expect, test } from "bun:test";
import { secrets, settings } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { assertPrivateDatabase } from "../../test/private-database";
import { readConfiguration, resetConfiguration, writeConfiguration } from "./configuration";

const suite = suiteFor("database", "valkey");
const key = "filesv2.configuration";
suite("Files unreadable settings recovery", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await sql`CREATE TABLE IF NOT EXISTS settings.entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
  });
  afterAll(async () => {
    await resetConfiguration();
  });
  test("token retention never overwrites a foreign encrypted configuration; explicit token replacement and reset recover", async () => {
    // Choose a foreign key by verifying the fixture cannot decrypt under this process.
    let ciphertext = await crypto.symmetric.encrypt({
      payload: JSON.stringify("foreign configuration"),
      key: "ab".repeat(32),
      stretched: false,
    });
    try {
      await secrets.decrypt(ciphertext);
      ciphertext = await crypto.symmetric.encrypt({
        payload: JSON.stringify("foreign configuration"),
        key: "cd".repeat(32),
        stretched: false,
      });
    } catch {
      /* Expected for the foreign key. */
    }
    const stamp = "2026-01-02T03:04:05.000Z";
    await sql`INSERT INTO settings.entries (key, value, updated_at) VALUES (${key}, ${ciphertext}, ${stamp}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`;
    await redis.del(`settings:${key}`);
    const { token: _token, tokenConfigured: _configured, unreadable: _unreadable, ...input } = await readConfiguration();
    expect(_unreadable).toBe(true);
    await expect(writeConfiguration(input)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
    const [row] = await sql<{ value: string; updated_at: Date }[]>`SELECT value,updated_at FROM settings.entries WHERE key=${key}`;
    expect(row?.value).toBe(ciphertext);
    expect(row?.updated_at.toISOString()).toBe(stamp);
    await writeConfiguration({ ...input, token: "new-filegate-token" });
    expect(await readConfiguration()).toMatchObject({ unreadable: false, tokenConfigured: true, token: "new-filegate-token" });
    expect((await settings.read(key)).stored).toBe("readable");
    await resetConfiguration();
    expect((await settings.read(key)).stored).toBe("none");
  });
});
