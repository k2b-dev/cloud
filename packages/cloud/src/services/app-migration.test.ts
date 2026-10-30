import { expect, test } from "bun:test";
import { evaluateAppMigration, type MigrationInstance, readAppMigrationStatus } from "./app-migration";

const keyId = "22222222-2222-4222-8222-222222222222";
const bootstrap = (mode: "core" | "env") => ({
  mode,
  ...(mode === "core" ? { keyId } : {}),
  keyFormat: "cloud-app-key-v1",
  protocol: 1,
  sources: {
    database: { url: mode },
    valkey: { url: mode },
    nats: { servers: mode, namespace: mode, replicas: mode, ignoreClusterUpdates: mode, creds: mode, ca: mode },
    appSecret: { current: mode },
  },
});
const instance = (appId: string, mode: "core" | "env", instanceId = "one"): MigrationInstance => ({
  appId,
  instanceId,
  hostname: "host",
  bootstrap: bootstrap(mode),
});
const evaluate = (instances: MigrationInstance[] = [], other: Partial<Parameters<typeof evaluateAppMigration>[0]> = {}) =>
  evaluateAppMigration({ activeKeys: [{ appId: "mail", keyId }], registeredApps: ["mail"], instances, expect: [], allowEnv: [], ...other });

test("inventory includes keyed, registered and explicit apps, excludes Core/Gateway, and catches silent or stopped apps", () => {
  const result = evaluate([], {
    activeKeys: [
      { appId: "stopped", keyId },
      { appId: "core", keyId },
    ],
    registeredApps: ["silent", "gateway"],
    expect: ["inventory"],
  });
  expect(result.apps.map((a) => [a.appId, a.status])).toEqual([
    ["inventory", "stopped"],
    ["silent", "unknown"],
    ["stopped", "stopped"],
  ]);
  expect(result.needsAttention).toBe(true);
  expect(evaluateAppMigration({ activeKeys: [], registeredApps: [], expect: [], allowEnv: [], instances: [] }).needsAttention).toBe(true);
});
test("unknown or malformed metadata never passes, even with an env exception", () => {
  for (const metadata of [
    undefined,
    {},
    { ...bootstrap("core"), keyId: undefined },
    { ...bootstrap("core"), protocol: 2 },
    { ...bootstrap("env"), sources: {} },
  ]) {
    const result = evaluate([{ appId: "mail", instanceId: "old", hostname: "host", bootstrap: metadata }], { allowEnv: ["mail"] });
    expect(result.apps[0]?.status).toBe("unknown");
    expect(result.needsAttention).toBe(true);
  }
});
test("all replicas must use Core; one environment override is visible and requires an explicit exception", () => {
  expect(evaluate([instance("mail", "core")]).needsAttention).toBe(false);
  const mixed = [instance("mail", "core"), instance("mail", "env", "two")];
  expect(evaluate(mixed).apps[0]?.status).toBe("mixed");
  expect(evaluate(mixed).needsAttention).toBe(true);
  expect(evaluate(mixed, { allowEnv: ["mail"] }).needsAttention).toBe(false);
  const overridden = bootstrap("core");
  overridden.sources.database.url = "env";
  expect(evaluate([{ appId: "mail", instanceId: "one", hostname: "host", bootstrap: overridden }]).apps[0]?.status).toBe("env");
  expect(evaluate([], { allowEnv: ["mail"] }).needsAttention).toBe(true);
});
test("invalid registry rows and an unregistered live instance remain visible and block completion", () => {
  expect(evaluate([instance("mail", "core")], { registryIssues: [{ key: "apps/old", reason: "Invalid record" }] }).needsAttention).toBe(
    true,
  );
  expect(evaluate([instance("third-party", "env")], { activeKeys: [], registeredApps: [] }).apps[0]?.appId).toBe("third-party");
});

test("status service enforces administrator access before opening its data sources", async () => {
  const result = await readAppMigrationStatus({ actor: { roles: [] }, expect: [], allowEnv: [] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.status).toBe(403);
});

test("a replica must report a current key belonging to its app", () => {
  const replica = instance("mail", "core");
  for (const activeKeys of [[], [{ appId: "other", keyId }], [{ appId: "mail", keyId: "33333333-3333-4333-8333-333333333333" }]]) {
    const result = evaluate([replica], { activeKeys, allowEnv: ["mail"] });
    expect(result.apps.find((app) => app.appId === "mail")?.status).toBe("unknown");
    expect(result.needsAttention).toBe(true);
  }
  // Rotation: keep both keys active until every replica reports the new one.
  expect(
    evaluate([replica], {
      activeKeys: [
        { appId: "mail", keyId },
        { appId: "mail", keyId: "33333333-3333-4333-8333-333333333333" },
      ],
    }).needsAttention,
  ).toBe(false);
});
