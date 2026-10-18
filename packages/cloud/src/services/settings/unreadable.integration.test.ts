import { afterAll, beforeEach, expect, test } from "bun:test";
import { crypto } from "@k2b/stdlib";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { settingsService } from "./app";
import { encryptValue, getAppSecret } from "./crypto";
import { registerSettings } from "./defaults";
import * as settings from "./index";

const suite = suiteFor("database", "valkey");
const prefix = `test.unreadable_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
const key = `${prefix}.url`;
const secretKey = `${prefix}.secret`;
const lockKey = `${prefix}.lock_order`;
const stamp = "2026-01-02T03:04:05.000Z";
const fallback = "https://fallback.test";
registerSettings([
  { key, kind: "url", default: "", envFallback: () => fallback, description: "Test only.", label: "Unreadable probe", group: prefix },
  { key: secretKey, kind: "secret", default: "", description: "Test only.", label: "Secret probe", group: prefix },
  { key: lockKey, kind: "url", default: "", description: "Test only.", label: "Lock order probe", group: prefix },
]);

suite("unreadable settings preserve stored data", () => {
  const foreignCiphertext = async (plaintext = "https://saved.test") =>
    crypto.symmetric.encrypt({
      payload: JSON.stringify(plaintext),
      key: getAppSecret() === "ab".repeat(32) ? "cd".repeat(32) : "ab".repeat(32),
      stretched: false,
    });
  const row = async (probe = key) =>
    (
      await sql<{ value: string; updated_at: Date }[]>`
    SELECT value, updated_at FROM settings.entries WHERE key = ${probe}
  `
    )[0];
  const insert = async (ciphertext: string, probe = key) => {
    await sql`INSERT INTO settings.entries (key, value, updated_at) VALUES (${probe}, ${ciphertext}, ${stamp}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
    await redis.del(`settings:${probe}`);
  };
  const clear = async () => {
    await settings.remove(key);
    await settings.remove(secretKey);
    await settings.remove(lockKey);
  };
  beforeEach(clear);
  afterAll(clear);

  test("a table SHARE lock and concurrent settings writes do not deadlock", async () => {
    await settings.set(lockKey, "https://initial.test");
    let concurrentWrite: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`LOCK TABLE settings.entries IN SHARE MODE`;
        // Observe rejection immediately and drain the writer even if A rolls back.
        concurrentWrite = Promise.allSettled([settings.set(lockKey, "https://b.test")]);
        let blocked = false;
        for (let poll = 0; poll < 100; poll++) {
          const [row] = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM pg_locks
            WHERE NOT granted AND relation = 'settings.entries'::regclass
          `;
          if (row && row.count > 0) {
            blocked = true;
            break;
          }
          await Bun.sleep(20);
        }
        if (!blocked) throw new Error("Concurrent settings write did not block on the table lock");
        await settings.set(lockKey, "https://a.test", tx);
      });
      await settings.invalidateSettingsCache([lockKey]);
      expect(await concurrentWrite).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(await settings.read(lockKey)).toEqual({ stored: "readable", value: "https://b.test" });
    } finally {
      await concurrentWrite;
    }
  });

  for (const invalid of [false, true])
    test(`decrypt${invalid ? "able but invalid" : "ion failure"} rows require explicit recovery`, async () => {
      const ciphertext = invalid ? await encryptValue("not a url") : await foreignCiphertext();
      await insert(ciphertext);
      expect(await settings.read(key)).toEqual({ stored: "unreadable", value: fallback });
      expect((await settings.getAll()).find((entry) => entry.key === key)).toMatchObject({
        unreadable: true,
        isCustom: true,
        valueSource: "env",
        value: fallback,
      });
      try {
        await settings.set(key, "https://replacement.test");
        throw new Error("Expected write refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(settings.SettingUnreadableError);
        expect(error).toMatchObject({ status: 409, key, code: "setting_unreadable" });
      }
      await expect(sql.begin((tx) => settings.set(key, "https://replacement.test", tx))).rejects.toBeInstanceOf(
        settings.SettingUnreadableError,
      );
      expect((await row())?.value).toBe(ciphertext);
      expect((await row())?.updated_at.toISOString()).toBe(stamp);
      await settings.set(key, "https://replacement.test", undefined, { replaceUnreadable: true });
      expect(await settings.read(key)).toEqual({ stored: "readable", value: "https://replacement.test" });
      expect((await settings.getAll()).find((entry) => entry.key === key)).toMatchObject({ unreadable: false, valueSource: "custom" });
      await insert(ciphertext);
      await settings.remove(key);
      expect(await settings.read(key)).toEqual({ stored: "none", value: fallback });
      expect((await settings.getAll()).find((entry) => entry.key === key)).toMatchObject({ unreadable: false, isCustom: false });
    });

  test("shared plaintext cache cannot hide an unreadable stored row", async () => {
    const ciphertext = await foreignCiphertext();
    await insert(ciphertext);
    const cacheKey = `settings:${key}`;
    const cached = JSON.stringify("https://saved.test");
    try {
      // A process with the right APP_SECRET can populate the shared value cache.
      await redis.set(cacheKey, cached);
      expect(await settings.get<string>(key)).toBe("https://saved.test");
      expect(await settings.read(key)).toEqual({ stored: "unreadable", value: fallback });
      expect((await settings.getAll()).find((entry) => entry.key === key)).toMatchObject({
        unreadable: true,
        isCustom: true,
        valueSource: "env",
        value: fallback,
      });
      await expect(settings.set(key, "https://replacement.test")).rejects.toBeInstanceOf(settings.SettingUnreadableError);
      expect((await row())?.value).toBe(ciphertext);
      expect((await row())?.updated_at.toISOString()).toBe(stamp);
      expect(await redis.get(cacheKey)).toBe(cached);
    } finally {
      await redis.del(cacheKey);
    }
  });

  test("secret lists expose neither fallback plaintext nor ciphertext", async () => {
    const plaintext = "secret-probe-plaintext";
    const ciphertext = await foreignCiphertext(plaintext);
    await insert(ciphertext, secretKey);
    expect(await settings.read(secretKey)).toEqual({ stored: "unreadable", value: "" });
    expect((await settings.getAll()).find((entry) => entry.key === secretKey)).toMatchObject({
      unreadable: true,
      isCustom: true,
      valueSource: "default",
      value: "",
    });
    let list = await settingsService.entry.list({ filter: { group: prefix } });
    expect(JSON.stringify(list)).not.toContain(ciphertext);
    expect(JSON.stringify(list)).not.toContain(plaintext);
    await settings.set(secretKey, plaintext, undefined, { replaceUnreadable: true });
    list = await settingsService.entry.list({ filter: { group: prefix } });
    expect(JSON.stringify(list)).not.toContain(plaintext);
    expect(JSON.stringify(list)).not.toContain((await row(secretKey))!.value);
  });
});
