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
const stamp = "2026-01-02T03:04:05.000Z";
const fallback = "https://fallback.test";
registerSettings([
  { key, kind: "url", default: "", envFallback: () => fallback, description: "Test only.", label: "Unreadable probe", group: prefix },
  { key: secretKey, kind: "secret", default: "", description: "Test only.", label: "Secret probe", group: prefix },
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
  };
  beforeEach(clear);
  afterAll(clear);

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
      // Repeat to cover the cached missing marker as well as the database miss.
      for (let attempt = 0; attempt < 2; attempt++) expect(await settings.read(key)).toEqual({ stored: "none", value: fallback });
      expect((await settings.getAll()).find((entry) => entry.key === key)).toMatchObject({ unreadable: false, isCustom: false });
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
