import { expect, test } from "bun:test";
import { APP_REGISTRY_TTL_MS } from "../_internal/registry";
import { appSecretRootId } from "../runtime/app-secret";
import { evaluateSecretRotation, readSecretRotationStatus, type SecretRotationInstance } from "./secret-status";

const A = appSecretRootId("ab".repeat(32)),
  B = appSecretRootId("cd".repeat(32));
const changedAt = "2030-01-02T00:00:00.000Z",
  startedAt = "2030-01-02T00:03:01.000Z",
  checkedAt = "2030-01-02T00:04:00.000Z";
const now = new Date("2030-01-02T00:05:00.000Z");
const instance = (appId: string, overrides: Record<string, unknown> = {}): SecretRotationInstance => ({
  appId,
  instanceId: `${appId}-one`,
  secrets: { current: B, previous: A, next: null, changedAt, owners: [], ...overrides },
});
const owner = { id: "credentials", rows: 3, previousOnly: 0, unreadable: 0, startedAt, checkedAt };
const ready = () => [instance("core", { owners: [owner] }), instance("gateway"), instance("mail", { owners: [owner] })];
const evaluate = (instances: SecretRotationInstance[], expect: string[] = []) =>
  evaluateSecretRotation({ registeredApps: ["core", "mail"], instances, expect, now });

test("every live instance, Core and Gateway included, must share a current root and fresh owner checks", () => {
  expect(evaluate(ready())).toMatchObject({ ready: true, current: B, lastRingChange: changedAt });
  expect(evaluate([...ready(), instance("mail", { current: A, previous: null, next: B })])).toMatchObject({ ready: false, current: null });
  expect(evaluate(ready().filter((entry) => entry.appId !== "gateway")).apps.find((app) => app.appId === "gateway")?.reasons).toContain(
    "no_live_instance",
  );
  expect(evaluate(ready(), ["stopped-app"]).apps.find((app) => app.appId === "stopped-app")?.reasons).toContain("no_live_instance");
  expect(evaluate([...ready(), { appId: "unknown", instanceId: "old-code" }]).ready).toBe(false);
});

test("missing owner declarations, stale checks, unreadable rows and previous-only rows block removal", () => {
  for (const overrides of [
    { owners: undefined },
    { next: B },
    { previous: B },
    { next: A },
    { owners: [{ ...owner, checkedAt: null }] },
    { owners: [{ ...owner, startedAt: null }] },
    { owners: [{ ...owner, startedAt: undefined }] },
    { owners: [{ ...owner, startedAt: changedAt }] },
    { owners: [{ ...owner, startedAt: "2030-01-02T00:04:01.000Z" }] },
    { owners: [{ ...owner, checkedAt: changedAt }] },
    { owners: [{ ...owner, checkedAt: "2030-01-02T00:06:00.000Z" }] },
    { owners: [{ ...owner, previousOnly: 1 }] },
    { owners: [{ ...owner, unreadable: 1 }] },
    { owners: [{ ...owner, unreadable: 4 }] },
    { owners: [owner, owner] },
  ])
    expect(evaluate([instance("core", overrides), instance("gateway"), instance("mail")]).ready).toBe(false);
  // Explicit [] is a declaration, so apps without retained ciphertext can be ready.
  expect(evaluate([instance("core"), instance("gateway"), instance("mail")]).ready).toBe(true);
});

test("a later ring rollout invalidates earlier owner checks across every application", () => {
  const instances = ready();
  instances.push(instance("gateway", { changedAt: "2030-01-02T00:01:30.000Z" }));
  const result = evaluate(instances);
  expect(result.ready).toBe(false);
  expect(result.apps.find((app) => app.appId === "core")?.reasons).toContain("stale_owner_check:credentials");
});

test("the completed pass must start strictly after the latest ring change plus the registry instance TTL", () => {
  const boundary = Date.parse(changedAt) + APP_REGISTRY_TTL_MS;
  for (const offset of [-1, 0, 1]) {
    const instances = ready();
    instances[0] = instance("core", { owners: [{ ...owner, startedAt: new Date(boundary + offset).toISOString() }] });
    expect(evaluate(instances).ready).toBe(offset > 0);
  }
});

test("registry problems and declaration drift cannot be interpreted as empty clean owners", () => {
  expect(evaluate([...ready(), instance("mail")]).apps.find((app) => app.appId === "mail")?.reasons).toContain("owner_declaration_drift");
  expect(
    evaluateSecretRotation({
      registeredApps: [],
      instances: ready(),
      expect: [],
      now,
      registryIssues: [{ key: "bad", reason: "invalid metadata" }],
    }).ready,
  ).toBe(false);
});

test("non-administrators are denied before registry or app data is read", async () => {
  expect(await readSecretRotationStatus({ actor: { roles: ["user"] }, expect: [] })).toMatchObject({ ok: false, error: { status: 403 } });
});
