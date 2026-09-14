import { describe, expect, test } from "bun:test";
import { get } from "@k2b/cloud/services/settings";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { redis, sql } from "bun";
import { migrate } from "./settings";

const suite = process.env.CLOUD_CACHE_TEST === "1" && process.env.DATABASE_URL?.endsWith("/cloud_cache_test") ? describe : describe.skip;
const key = "user.account_requests.enabled";
suite("settings migration cache coherence", () => {
  test("fresh installations retain the opt-in default across concurrent starts", async () => {
    // This suite only runs in the runner's disposable database.
    await sql`DROP SCHEMA settings CASCADE`.simple();
    await Promise.all([migrate(), migrate()]);
    expect(await get<boolean>(key)).toBe(false);
    expect((await sql`SELECT name FROM settings.migrations`).length).toBe(1);
    expect((await sql`SELECT key FROM settings.entries`).length).toBe(0);
  });
  test("an upgrade invalidates an existing negative cache after its commit", async () => {
    await sql`DELETE FROM settings.migrations WHERE name = 'account-request-opt-in-v1'`;
    await sql`DELETE FROM settings.entries WHERE key = ${key}`;
    await redis.del(`settings:${key}`);
    expect(await get<boolean>(key)).toBe(false);
    await migrate();
    expect(await redis.get(`settings:${key}`)).toBeNull();
    expect(await get<boolean>(key)).toBe(true);
  });
  test("existing overrides and migration receipts survive repeated starts", async () => {
    await sql`UPDATE settings.entries SET value = ${await encryptValue(false)} WHERE key = ${key}`;
    await migrate();
    expect(await get<boolean>(key)).toBe(false);
    await sql`DELETE FROM settings.entries WHERE key = ${key}`;
    await Promise.all([migrate(), migrate()]);
    expect(await get<boolean>(key)).toBe(false);
    expect((await sql`SELECT key FROM settings.entries WHERE key = ${key}`).length).toBe(0);
  });
});
