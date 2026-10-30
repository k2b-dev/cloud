import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { connections } from "../../runtime/connections";
import { stubConnections } from "../../runtime/connections.test-fixture";
import { encryptValue } from "./crypto";
import { registerSettings, SETTINGS } from "./defaults";
import { readEnvSettingsStatus } from "./env-status";
import * as settings from "./index";

/**
 * Uses an in-process probe key, like `transaction.integration.test.ts`.
 * `gotenberg.url` and `app.url` both use `envBootstrap`. `loadCache()` bootstraps every env-backed setting, so the suite unsets
 * their variables while it runs and first checks that only the probe would
 * bootstrap; otherwise the test runner's `GOTENBERG_URL` would become a stored
 * `gotenberg.url` row in the shared test database.
 */
const suite = suiteFor("database", "valkey");
const key = `test.bootstrap_probe_${crypto.randomUUID().replaceAll("-", "")}`;
const variables = SETTINGS.flatMap((def) => (def.envVariable ? [def.envVariable] : []));
let environment: string | undefined = "http://renderer.bootstrap.test:3000";
registerSettings([
  {
    key,
    kind: "url",
    default: "",
    label: "Bootstrap probe",
    description: "Test only.",
    group: "test",
    envBootstrap: () => {
      if (environment === "throw") throw new Error("private parser input");
      return environment;
    },
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
    expect((await readEnvSettingsStatus()).find((entry) => entry.key === key)?.conflict).toBe("differs");
  });

  test("invalid env bootstrap is ignored with a warning and no stored row", async () => {
    await settings.remove(key);
    environment = "not a url";
    const warn = spyOn(console, "warn");
    try {
      for (const invalid of ["not a url", "throw"]) {
        environment = invalid;
        await settings.loadCache();
        expect((await settings.read(key)).stored).toBe("none");
        expect((await readEnvSettingsStatus()).find((entry) => entry.key === key)?.invalidEnvValue).toBe(true);
        expect(warn.mock.calls.some((call) => String(call[0]).includes(`ignoring invalid bootstrap value for "${key}"`))).toBe(true);
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private parser input");
    } finally {
      warn.mockRestore();
      environment = "http://renderer.environment.test:3000";
    }
  });

  test("an explicitly supplied empty migrated list bootstraps once", async () => {
    const listKey = `${key}_list`;
    let listValue: string[] | undefined = [];
    registerSettings([
      {
        key: listKey,
        kind: "string_list",
        default: ["rsql"],
        group: "test",
        description: "Test list bootstrap",
        envVariable: "TEST_BOOTSTRAP_LIST",
        envBootstrap: () => listValue,
      },
    ]);
    try {
      await settings.loadCache();
      expect(await settings.read(listKey)).toEqual({ stored: "readable", value: [] });
      await settings.set(listKey, ["saved"]);
      await settings.loadCache();
      expect(await settings.get<string[]>(listKey)).toEqual(["saved"]);
    } finally {
      listValue = undefined;
      await settings.remove(listKey);
    }
  });

  test("startup never overwrites a stored row that this APP_SECRET cannot decrypt", async () => {
    const original = connections();
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
    const secretStub = stubConnections({ ...original, appSecret: { current: "a-different-secret-b" } });
    try {
      await settings.loadCache();
      const [row] = await sql<{ value: string; updated_at: Date }[]>`SELECT value, updated_at FROM settings.entries WHERE key = ${key}`;
      expect(row?.value).toBe(ciphertext);
      expect(row?.updated_at.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      // Reads under the wrong key keep the documented fallback.
      expect(await settings.get<string>(key)).toBe("http://renderer.environment-of-b.test:3000");
      const messages = warn.mock.calls.map((call) => call.join(" "));
      expect(messages).toContain(
        `[settings] cannot decrypt stored value for "${key}" with this APP_SECRET; keeping the row unchanged, reads use the environment fallback or default`,
      );
      for (const message of messages) {
        expect(message).not.toContain(adminValue);
        expect(message).not.toContain(ciphertext);
      }
    } finally {
      warn.mockRestore();
      secretStub.mockRestore();
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
