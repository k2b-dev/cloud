import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { encryptValue } from "./crypto";
import { registerSettings } from "./defaults";
import { MISSING_SETTING } from "../cache-fill";
import { buildProjectedUser } from "../session/user";
import { bulkRead, invalidateSettingsCacheForAdmin, invalidateSettingsCache, readKey } from "./store";

const enabled = process.env.CLOUD_CACHE_TEST === "1" && process.env.DATABASE_URL?.endsWith("/cloud_cache_test");
const suite = enabled ? describe : describe.skip;
const key = `test.cache.${crypto.randomUUID()}`;
const cacheKey = `settings:${key}`;
const fallbackKey = key + ".fallback";
let fallback = "first environment";
registerSettings([
  {
    key: fallbackKey,
    kind: "string",
    default: "default",
    label: "Test",
    description: "Cache fallback fixture",
    group: "test",
    envFallback: () => fallback,
  },
]);
suite("settings cache upgrade compatibility", () => {
  beforeAll(async () => {
    await redis.del(cacheKey);
  });
  afterAll(async () => {
    await sql`DELETE FROM settings.entries WHERE key = ${key}`;
    await redis.del(cacheKey, `settings:${fallbackKey}`);
  });
  test("caches missing rows, invalidates after writes, and preserves false and null", async () => {
    expect(await readKey(key)).toBeUndefined();
    expect(await redis.get(cacheKey)).toBe(MISSING_SETTING);
    await sql`INSERT INTO settings.entries (key, value) VALUES (${key}, ${await encryptValue(false)})`;
    // A warm negative hit never reads the newly inserted row until invalidation.
    expect(await readKey(key)).toBeUndefined();
    await invalidateSettingsCache([key]);
    expect(await readKey(key)).toBe(false);
    expect(await redis.get(cacheKey)).toBe("false");
    await sql`UPDATE settings.entries SET value = ${await encryptValue(null)} WHERE key = ${key}`;
    expect((await bulkRead([key])).get(key)).toBe(false);
    await invalidateSettingsCache([key]);
    expect(await readKey(key)).toBeNull();
    expect(await redis.get(cacheKey)).toBe("null");
  });
  test("negative entries retain each process's local fallback instead of serializing it", async () => {
    expect(await readKey(fallbackKey)).toBe("first environment");
    expect(await redis.get(`settings:${fallbackKey}`)).toBe(MISSING_SETTING);
    fallback = "second environment";
    expect(await readKey(fallbackKey)).toBe("second environment");
  });
  test("admin clear includes discovered app keys and leaves unrelated Redis data intact", async () => {
    const appKey = key + ".external-app";
    const unrelated = `cache-test:unrelated:${key}`;
    const actor = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
    try {
      await redis.set(`settings:${appKey}`, '"stale"');
      await redis.set(`settings:${fallbackKey}`, '"stale"');
      await redis.set(unrelated, "keep");
      await invalidateSettingsCacheForAdmin(actor, [appKey, appKey]);
      expect(await redis.get(`settings:${appKey}`)).toBeNull();
      expect(await redis.get(`settings:${fallbackKey}`)).toBeNull();
      expect(await redis.get(unrelated)).toBe("keep");
    } finally {
      await redis.del(`settings:${appKey}`, unrelated);
    }
  });
  test("reads existing JSON cache values and recovers corrupt values", async () => {
    await redis.set(cacheKey, JSON.stringify("existing deployment"));
    expect(await readKey(key)).toBe("existing deployment");
    await redis.set(cacheKey, "broken JSON");
    expect(await readKey(key)).toBeNull();
    expect(await redis.get(cacheKey)).toBe("null");
    // Previous readers JSON.parse the marker, miss, and fall back to Postgres.
    expect(() => JSON.parse(MISSING_SETTING)).toThrow();
  });
});
