import { afterAll, beforeAll, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
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
});
