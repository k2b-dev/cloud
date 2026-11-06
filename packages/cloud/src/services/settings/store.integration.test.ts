import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { redis, sql } from "../../runtime/clients";
import { connections } from "../../runtime/connections";
import { stubConnections } from "../../runtime/connections.test-fixture";
import { MISSING_SETTING } from "../cache-fill";
import { getIdentityRuntimeConfig, invalidateIdentityRuntimeConfig } from "../identity/runtime-config";
import { requestCacheRedis } from "../request-cache-redis";
import { buildProjectedUser } from "../session/user";
import { decryptValue, encryptValue } from "./crypto";
import { registerSettings } from "./defaults";
import { get, loadCache, read, remove, set } from "./index";
import { preserveTestSettings, useTestSettings } from "./settings.test-fixture";
import { bulkRead, invalidateSettingsCache, invalidateSettingsCacheForAdmin, readKey } from "./store";

const suite = suiteFor("database", "valkey");
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

const secretKey = key + ".secret";
const otherSecretKey = key + ".other-secret";
const endpointKey = key + ".servers";
const accessKey = key + ".access";
registerSettings([
  { key: endpointKey, kind: "string_list", default: [], group: "test", description: "Endpoint probe", resetOnChange: [accessKey] },
  { key: accessKey, kind: "secret", default: "", group: "test", description: "Bound access probe" },
]);
registerSettings([{ key: secretKey, kind: "secret", default: "", label: "Test", description: "Secret cache probe", group: "test" }]);
registerSettings([{ key: otherSecretKey, kind: "secret", default: "", description: "Other secret cache probe", group: "test" }]);
suite("secret setting cache boundaries", () => {
  preserveTestSettings(["app.url", "gotenberg.url"]);
  afterAll(async () => {
    await remove(secretKey);
    await remove(otherSecretKey);
    await remove(endpointKey);
    await remove(accessKey);
  });
  test("healthy settings startup completes after the prior dependency exhausted its recovery allowance", async () => {
    await loadCache(AbortSignal.abort());
  });
  test("set and get never put secret plaintext in Valkey, including batch reads", async () => {
    const secret = "fixture-sensitive-value";
    await set(secretKey, secret);
    expect(await get<string>(secretKey)).toBe(secret);
    expect((await bulkRead([fallbackKey, secretKey])).get(secretKey)).toBe(secret);
    const cached = await redis.get(`settings:${secretKey}`);
    expect(cached).toStartWith("!cloud:encrypted-setting:v2:");
    expect(cached).not.toContain(secret);
    expect(await decryptValue(cached!.slice("!cloud:encrypted-setting:v2:".length))).toEqual({ k: secretKey, v: secret });
    expect(await get<string>(secretKey)).toBe(secret);
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "settings:*", "COUNT", 100);
      cursor = next;
      if (keys.length) for (const value of await redis.mget(...keys)) expect(value ?? "").not.toContain(secret);
    } while (cursor !== "0");
    await remove(secretKey);
    expect(await get<string>(secretKey)).toBe("");
    expect(await redis.get(`settings:${secretKey}`)).toBe(MISSING_SETTING);
  });
  test("copied secret cache entries fall back to the destination's database row", async () => {
    await set(secretKey, "source-value");
    await set(otherSecretKey, "destination-value");
    expect(await get<string>(secretKey)).toBe("source-value");
    const source = await redis.get(`settings:${secretKey}`);
    await redis.set(`settings:${otherSecretKey}`, source!);
    expect(await get<string>(otherSecretKey)).toBe("destination-value");
  });
  test("plaintext cache entries warn once per key without exposing values", async () => {
    await set(otherSecretKey, "stored-value");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await redis.set(`settings:${otherSecretKey}`, JSON.stringify("legacy-value"));
        expect(await get<string>(otherSecretKey)).toBe("stored-value");
      }
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]).toEqual([
        `[settings] ignoring plaintext cache entry for "${otherSecretKey}"; update all application processes`,
      ]);
    } finally {
      warning.mockRestore();
    }
  });
  test("bound secret reads bypass stale cache values and discard access after an endpoint change", async () => {
    await set(endpointKey, ["nats://first.example.test:4222"]);
    await set(accessKey, "bound-sensitive-value");
    const cacheKey = `settings:${accessKey}`;
    expect(await get<string>(accessKey)).toBe("bound-sensitive-value");
    expect(await redis.get(cacheKey)).toBeNull();
    await redis.set(cacheKey, JSON.stringify("legacy-access"));
    expect((await bulkRead([endpointKey, accessKey, secretKey])).get(accessKey)).toBe("bound-sensitive-value");
    await set(endpointKey, ["nats://second.example.test:4222"]);
    expect(await get<string>(accessKey)).toBe("");
    expect(await redis.get(cacheKey)).toBeNull();
  });
  test("a process with another encryption key cannot read a warm secret cache entry", async () => {
    const original = connections();
    await set(secretKey, "secret-under-original-key");
    expect(await get<string>(secretKey)).toBe("secret-under-original-key");
    const cached = await redis.get(`settings:${secretKey}`);
    const secretStub = stubConnections({ ...original, appSecret: { current: "cd".repeat(32) } });
    try {
      expect(await get<string>(secretKey)).toBe("");
      expect(await redis.get(`settings:${secretKey}`)).toBe(cached);
    } finally {
      secretStub.mockRestore();
    }
    expect(await get<string>(secretKey)).toBe("secret-under-original-key");
  });
  test("reads ignore old secret cache entries and startup evicts registered and retired entries", async () => {
    const retired = `settings:${secretKey}.retired`;
    const unrelated = `cache-test:${secretKey}`;
    const marker = "settings-cache:format";
    const previousMarker = await redis.get(marker);
    const scan = spyOn(await requestCacheRedis(), "scan");
    try {
      await redis.del(marker);
      await set(secretKey, "current-secret");
      await redis.set(`settings:${secretKey}`, JSON.stringify("old-secret"));
      await redis.set(retired, JSON.stringify("retired-secret"));
      await redis.set(unrelated, "keep");
      expect(await get<string>(secretKey)).toBe("current-secret");
      await loadCache();
      const scanned = scan.mock.calls.length;
      expect(scanned).toBeGreaterThan(0);
      expect(scan.mock.calls[0]).toEqual(["0", "MATCH", "settings:*", "COUNT", 1000]);
      expect(await redis.get(`settings:${secretKey}`)).toBeNull();
      expect(await redis.get(retired)).toBeNull();
      await redis.set(retired, "after-sweep");
      await loadCache();
      expect(scan).toHaveBeenCalledTimes(scanned);
      expect(await redis.get(retired)).toBe("after-sweep");
      await redis.del(marker);
      await loadCache();
      expect(scan.mock.calls.length).toBeGreaterThan(scanned);
      expect(await redis.get(`settings:${secretKey}`)).toBeNull();
      expect(await redis.get(retired)).toBeNull();
      expect(await redis.get(unrelated)).toBe("keep");
      expect(await get<string>(secretKey)).toBe("current-secret");
    } finally {
      scan.mockRestore();
      await redis.del(retired, unrelated);
      if (previousMarker === null) await redis.del(marker);
      else await redis.set(marker, previousMarker);
    }
  });
});

// Nested suites stand in for consecutive integration files sharing Postgres and Valkey.
// The incoming issuer deliberately differs from the consumer's declared origin.
suite("integration settings fixture isolation", () => {
  preserveTestSettings(["app.url", "user.allow_self_registration", "user.category.login.label"]);
  let fallbackLabel: string;
  beforeAll(async () => {
    await set("app.url", "https://previous-suite.example.test");
    await set("user.allow_self_registration", false);
    await remove("user.category.login.label");
    fallbackLabel = await get<string>("user.category.login.label");
    invalidateIdentityRuntimeConfig();
    expect((await getIdentityRuntimeConfig()).issuer).toBe("https://previous-suite.example.test");
  });

  describe("a consumer declares its own settings", () => {
    useTestSettings({
      "app.url": "http://localhost:3000",
      "user.allow_self_registration": true,
      "user.category.login.label": "Fixture label",
    });
    test("replaces inherited database, Valkey and process cache values", async () => {
      expect(await get<string>("app.url")).toBe("http://localhost:3000");
      expect(await get<boolean>("user.allow_self_registration")).toBe(true);
      expect(await get<string>("user.category.login.label")).toBe("Fixture label");
      expect((await getIdentityRuntimeConfig()).issuer).toBe("http://localhost:3000");
      // Some tests deliberately corrupt rows. Cleanup must still restore the saved readable value.
      await sql`UPDATE settings.entries SET value = 'not encrypted' WHERE key = 'user.allow_self_registration'`;
      expect((await read("user.allow_self_registration")).stored).toBe("unreadable");
    });
  });

  describe("the next consumer", () => {
    test("sees the original issuer, false values and absent rows after cleanup", async () => {
      expect(await get<string>("app.url")).toBe("https://previous-suite.example.test");
      expect(await get<boolean>("user.allow_self_registration")).toBe(false);
      expect((await getIdentityRuntimeConfig()).issuer).toBe("https://previous-suite.example.test");
      expect((await read("user.category.login.label")).stored).toBe("none");
      expect(await get<string>("user.category.login.label")).toBe(fallbackLabel);
    });
  });
});
