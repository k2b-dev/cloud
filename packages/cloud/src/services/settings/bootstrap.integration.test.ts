import { afterAll, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { registerSettings } from "./defaults";
import * as settings from "./index";

/**
 * Uses an in-process probe key, like `transaction.integration.test.ts`, so the
 * test never rewrites a setting an app reads. `gotenberg.url` and `app.url`
 * use the same `envBootstrap` / `envFallback` pair.
 */
const suite = suiteFor("database", "valkey");
const key = `test.bootstrap_probe_${crypto.randomUUID().replaceAll("-", "")}`;
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
  afterAll(async () => {
    await settings.remove(key);
    await redis.del(`settings:${key}`);
  });

  test("the environment bootstraps a missing setting and never replaces a stored one", async () => {
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
