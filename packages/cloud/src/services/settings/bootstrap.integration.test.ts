import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { env } from "../../config/env";
import { encryptValue } from "./crypto";
import { registerSettings, SETTINGS } from "./defaults";
import * as settings from "./index";

/**
 * Uses an in-process probe key, like `transaction.integration.test.ts`.
 * `gotenberg.url` and `app.url` use the same `envBootstrap` / `envFallback`
 * pair. `loadCache()` bootstraps every env-backed setting, so the suite unsets
 * their variables while it runs and first checks that only the probe would
 * bootstrap; otherwise the test runner's `GOTENBERG_URL` would become a stored
 * `gotenberg.url` row in the shared test database.
 */
const suite = suiteFor("database", "valkey");
const key = `test.bootstrap_probe_${crypto.randomUUID().replaceAll("-", "")}`;
const variables = ["APP_URL", "GOTENBERG_URL"];
let environment: string | undefined = "http://renderer.bootstrap.test:3000";
registerSettings([
  {
    key,
    kind: "url",
    default: "",
    label: "Bootstrap probe",
    description: "Test only.",
    group: "test",
    envBootstrap: () => environment,
    envFallback: () => environment,
  },
]);

suite("environment-backed settings", () => {
  const saved = new Map<string, string>();
  beforeAll(() => {
    for (const name of variables) {
      const value = process.env[name];
      if (value !== undefined) saved.set(name, value);
      delete process.env[name];
    }
  });
  afterAll(async () => {
    for (const [name, value] of saved) process.env[name] = value;
    await settings.remove(key);
    await redis.del(`settings:${key}`);
  });

  test("the environment bootstraps a missing setting and never replaces a stored one", async () => {
    expect(SETTINGS.filter((def) => def.key !== key && def.envBootstrap?.() !== undefined).map((def) => def.key)).toEqual([]);
    expect(await settings.get<string>(key)).toBe("http://renderer.bootstrap.test:3000");

    await settings.loadCache();
    const [row] = await sql<{ key: string }[]>`SELECT key FROM settings.entries WHERE key = ${key}`;
    expect(row?.key).toBe(key);
    environment = undefined;
    expect(await settings.get<string>(key)).toBe("http://renderer.bootstrap.test:3000");

    await settings.set(key, "http://renderer.admin.test:3000");
    environment = "http://renderer.changed.test:3000";
    await settings.loadCache();
    expect(await settings.get<string>(key)).toBe("http://renderer.admin.test:3000");
  });

  test("startup never overwrites a stored row that this APP_SECRET cannot decrypt", async () => {
    const original = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
    const adminValue = "http://renderer.saved-under-a.test:3000";
    const ciphertext = await encryptValue(adminValue);
    await sql`
      INSERT INTO settings.entries (key, value, updated_at)
      VALUES (${key}, ${ciphertext}, '2026-01-02T03:04:05Z')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
    await redis.del(`settings:${key}`);
    environment = "http://renderer.environment-of-b.test:3000";
    const warn = spyOn(console, "warn");
    Object.defineProperty(env, "APP_SECRET", { value: "a-different-secret-b", configurable: true });
    try {
      await settings.loadCache();
      const [row] = await sql<{ value: string; updated_at: Date }[]>`SELECT value, updated_at FROM settings.entries WHERE key = ${key}`;
      expect(row?.value).toBe(ciphertext);
      expect(row?.updated_at.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      // Reads under the wrong key keep the documented fallback.
      expect(await settings.get<string>(key)).toBe("http://renderer.environment-of-b.test:3000");
      const messages = warn.mock.calls.map((call) => call.join(" "));
      expect(messages.some((message) => message.includes(key))).toBe(true);
      expect(messages.some((message) => message.includes(adminValue) || message.includes(ciphertext))).toBe(false);
    } finally {
      warn.mockRestore();
      Object.defineProperty(env, "APP_SECRET", original);
      await redis.del(`settings:${key}`);
    }
    // The application with the original key still reads the saved value.
    expect(await settings.get<string>(key)).toBe(adminValue);
  });

  test("startup never overwrites a stored row that decrypts but fails validation", async () => {
    const ciphertext = await encryptValue("not a url");
    await sql`
      INSERT INTO settings.entries (key, value, updated_at)
      VALUES (${key}, ${ciphertext}, '2026-01-02T03:04:05Z')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
    await redis.del(`settings:${key}`);
    environment = "http://renderer.validation-fallback.test:3000";
    try {
      await settings.loadCache();
      const [row] = await sql<{ value: string; updated_at: Date }[]>`SELECT value, updated_at FROM settings.entries WHERE key = ${key}`;
      expect(row?.value).toBe(ciphertext);
      expect(row?.updated_at.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      expect(await settings.get<string>(key)).toBe("http://renderer.validation-fallback.test:3000");
    } finally {
      await settings.remove(key);
      await redis.del(`settings:${key}`);
    }
  });
});
