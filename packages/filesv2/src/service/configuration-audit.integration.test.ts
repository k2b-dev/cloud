import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import * as settingsCache from "@k2b/cloud/services/settings";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import { app } from "../config";
import type { UserFilesCall } from "./activity";
import { readConfiguration, resetConfiguration, writeConfiguration } from "./configuration";

const suite = suiteFor("database", "valkey");
const key = "filesv2.configuration";
const cacheKey = `settings:${key}`;
const stamp = "2030-05-15T12:00:00.000Z";
const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const input = {
  activityRetentionDays: 730,
  url: "https://private-filegate.test",
  token: "private-filegate-credential",
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};
const previous = { ...input, token: "previous-private-credential", activityRetentionDays: 365 };
type SettingRow = { value: string; xmin: string; updated_at: Date };
type AuditRow = {
  xmin: string;
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_uid: string | null;
  actor_provider: string | null;
  actor_roles: string[];
  target_type: string;
  target_id: string;
  target_label: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
};

suite("Files configuration security audit", () => {
  if (testActor.kind !== "user") throw new Error("Expected user fixture");
  const user = testActor.user;
  const call: UserFilesCall = {
    ...testCall(testActor),
    // Audit identity must come from the actor, never the permission subject.
    accessSubject: { type: "user", userId: "10000000-0000-4000-8000-000000000002" },
    requestId: "configuration-request",
    via: "agent",
    callingApp: "assistant",
    invocationId: "configuration-invocation",
    origin: "assistant",
  };
  const setting = async () => (await sql<SettingRow[]>`SELECT value,xmin::text,updated_at FROM settings.entries WHERE key=${key}`)[0];
  const events = () => sql<AuditRow[]>`SELECT *,xmin::text FROM audit.events ORDER BY id`;
  const deletions = () => sql<{ key: string; xmin: string }[]>`SELECT key,xmin::text FROM settings.configuration_test_deletions`;
  const state = async () => ({
    setting: await setting(),
    audit: await events(),
    cache: await redis.get(cacheKey),
    deletions: await deletions(),
  });
  const invalidate = settingsCache.invalidateSettingsCache;
  const save = (action: "update" | "reset", requestCall = call) =>
    action === "update" ? writeConfiguration(input, requestCall) : resetConfiguration(requestCall);
  function expectEvent(event: AuditRow | undefined, action: "update" | "reset", requestCall = call) {
    expect(event).toMatchObject({
      action: `filesv2.configuration.${action}`,
      outcome: "allowed",
      actor_user_id: user.id,
      actor_uid: null,
      actor_provider: null,
      actor_roles: [],
      target_type: key,
      target_id: key,
      target_label: null,
      request_id: requestCall.requestId,
    });
    expect(event?.metadata).toEqual({
      via: requestCall.via,
      calling_app: requestCall.callingApp,
      origin: requestCall.origin,
      invocation_id: requestCall.invocationId,
    });
    const evidence = JSON.stringify(event);
    for (const secret of [input.token, previous.token, input.url, input.cloud.root, "private-credential-id", "[REDACTED]"])
      expect(evidence).not.toContain(secret);
  }
  async function seed() {
    // Setup through the supported encrypted store, without fabricating a domain audit event.
    await settings.set(key, JSON.stringify(previous));
    expect(await app.settings.get(key)).toBe(JSON.stringify(previous));
    expect(await redis.get(cacheKey)).toBe(JSON.stringify(JSON.stringify(previous)));
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`.simple();
    await migrateAudit();
    // A transactional witness lets resets prove their xmin after the source row has been deleted.
    await sql`CREATE TABLE settings.configuration_test_deletions(key text NOT NULL)`.simple();
    await sql`CREATE FUNCTION settings.capture_configuration_test_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO settings.configuration_test_deletions(key) VALUES(OLD.key); RETURN OLD; END; $$`.simple();
    await sql`CREATE TRIGGER capture_configuration_test_deletion AFTER DELETE ON settings.entries
      FOR EACH ROW EXECUTE FUNCTION settings.capture_configuration_test_deletion()`.simple();
    await sql`CREATE FUNCTION audit.reject_configuration_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'configuration-audit-failure' THEN RAISE EXCEPTION 'configuration audit unavailable'; END IF;
        RETURN NEW;
      END; $$`.simple();
    await sql`CREATE TRIGGER reject_configuration_test_event BEFORE INSERT ON audit.events
      FOR EACH ROW EXECUTE FUNCTION audit.reject_configuration_test_event()`.simple();
    await sql`CREATE FUNCTION audit.reject_configuration_test_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'configuration-commit-failure' THEN RAISE EXCEPTION 'configuration commit unavailable'; END IF;
        RETURN NEW;
      END; $$`.simple();
    await sql`CREATE CONSTRAINT TRIGGER reject_configuration_test_commit AFTER INSERT ON audit.events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit.reject_configuration_test_commit()`.simple();
    await sql`CREATE FUNCTION settings.reject_configuration_test_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'configuration settings unavailable'; END; $$`.simple();
  });
  beforeEach(async () => {
    await sql`TRUNCATE settings.entries,audit.events,settings.configuration_test_deletions`.simple();
    await invalidate([key]);
  });
  afterEach(async () => {
    mock.restore();
    await invalidate([key]);
  });

  test("save encrypts the configuration and records the same xmin, without credentials or configuration in audit", async () => {
    await writeConfiguration(input, call);
    const stored = await setting();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "update");
    expect(stored?.xmin).toBe(rows[0]?.xmin);
    expect(stored?.value).not.toContain(input.token);
    expect(stored?.value).not.toContain(input.url);
    expect(await readConfiguration()).toEqual({ ...input, unreadable: false, tokenConfigured: true });
    // Every save is an administrative action, even when its value is unchanged.
    await writeConfiguration(input, call);
    expect(await events()).toHaveLength(2);
  });

  test("a save without a replacement token retains the encrypted credential and records one audit event", async () => {
    await seed();
    const { token: _token, ...retaining } = input;
    await writeConfiguration(retaining, call);
    expect(await readConfiguration()).toMatchObject({ token: previous.token, activityRetentionDays: 730 });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "update");
    expect((await setting())?.xmin).toBe(rows[0]?.xmin);
  });

  test("reset deletes the encrypted override and audits every reset, including an absent override", async () => {
    await seed();
    await resetConfiguration(call);
    expect(await setting()).toBeUndefined();
    expect(await readConfiguration()).toMatchObject({ activityRetentionDays: 365, token: "", tokenConfigured: false, unreadable: false });
    await resetConfiguration(call);
    const rows = await events();
    expect(rows).toHaveLength(2);
    for (const row of rows) expectEvent(row, "reset");
    expect(await deletions()).toEqual([{ key, xmin: rows[0]!.xmin }]);
    expect(await app.settings.get(key)).toBe("");
  });

  for (const action of ["update", "reset"] as const) {
    test(`${action} invalidates the warm cache only after both settings and audit are committed`, async () => {
      await seed();
      const cached = await redis.get(cacheKey);
      const invalidation = spyOn(settingsCache, "invalidateSettingsCache").mockImplementation(async (keys) => {
        expect(keys).toEqual([key]);
        expect(await redis.get(cacheKey)).toBe(cached);
        // These independent reads cannot see an uncommitted caller transaction.
        const rows = await events();
        expect(rows).toHaveLength(1);
        expectEvent(rows[0], action);
        if (action === "update") {
          expect((await setting())?.xmin).toBe(rows[0]?.xmin);
          expect(await readConfiguration()).toMatchObject({ token: input.token });
        } else {
          expect(await setting()).toBeUndefined();
          expect(await deletions()).toEqual([{ key, xmin: rows[0]!.xmin }]);
        }
        await invalidate(keys);
      });
      await save(action);
      expect(invalidation).toHaveBeenCalledTimes(1);
      expect(await redis.get(cacheKey)).toBeNull();
      const resolved = await app.settings.get(key);
      expect(resolved ? JSON.parse(resolved) : resolved).toEqual(action === "update" ? input : "");
    });

    for (const failure of ["audit", "commit"] as const) {
      test(`${action} rolls back the encrypted settings mutation on ${failure} failure and keeps the cache`, async () => {
        await seed();
        const before = await state();
        const invalidation = spyOn(settingsCache, "invalidateSettingsCache");
        await expect(save(action, { ...call, requestId: `configuration-${failure}-failure` })).rejects.toThrow(
          `configuration ${failure} unavailable`,
        );
        expect(await state()).toEqual(before);
        expect(invalidation).not.toHaveBeenCalled();
      });
    }

    test(`${action} does not audit or invalidate when the settings mutation fails`, async () => {
      await seed();
      const before = await state();
      const invalidation = spyOn(settingsCache, "invalidateSettingsCache");
      await sql`CREATE TRIGGER reject_configuration_test_mutation BEFORE INSERT OR UPDATE OR DELETE ON settings.entries
        FOR EACH ROW EXECUTE FUNCTION settings.reject_configuration_test_mutation()`.simple();
      try {
        await expect(save(action)).rejects.toThrow("configuration settings unavailable");
        expect(await state()).toEqual(before);
        expect(invalidation).not.toHaveBeenCalled();
      } finally {
        await sql`DROP TRIGGER reject_configuration_test_mutation ON settings.entries`.simple();
      }
    });

    test(`${action} reports cache failure after durable commit and recovers when invalidation is retried`, async () => {
      await seed();
      const cached = await redis.get(cacheKey);
      const invalidation = spyOn(settingsCache, "invalidateSettingsCache").mockImplementation(async () => {
        const rows = await events();
        expect(rows).toHaveLength(1);
        expectEvent(rows[0], action);
        if (action === "update") expect((await setting())?.xmin).toBe(rows[0]?.xmin);
        else expect(await setting()).toBeUndefined();
        throw new Error("configuration cache unavailable");
      });
      await expect(save(action)).rejects.toThrow("configuration cache unavailable");
      expect(invalidation).toHaveBeenCalledTimes(1);
      expect(await redis.get(cacheKey)).toBe(cached);
      expect(await app.settings.get(key)).toBe(JSON.stringify(previous));
      invalidation.mockRestore();
      await invalidate([key]);
      const resolved = await app.settings.get(key);
      expect(resolved ? JSON.parse(resolved) : resolved).toEqual(action === "update" ? input : "");
      expect(await events()).toHaveLength(1);
    });

    for (const via of ["web", "app", "api", "cli", "office", "app:inventory", "agent"] as const) {
      test(`${action} preserves the original ${via} call provenance`, async () => {
        const original = { ...call, via, requestId: `configuration-${action}-${via}` };
        await save(action, original);
        const rows = await events();
        expect(rows).toHaveLength(1);
        expectEvent(rows[0], action, original);
      });
    }
  }

  test("unreadable configuration refuses a merge but allows an explicit complete replacement", async () => {
    await sql`INSERT INTO settings.entries(key,value,updated_at) VALUES(${key},'unreadable-ciphertext',${stamp}::timestamptz)`;
    expect(await readConfiguration()).toMatchObject({ unreadable: true, token: "", tokenConfigured: false });
    const before = await state();
    const { token: _token, ...retaining } = input;
    await expect(writeConfiguration(retaining, call)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
    expect(await state()).toEqual(before);
    await writeConfiguration(input, call);
    expect(await readConfiguration()).toEqual({ ...input, unreadable: false, tokenConfigured: true });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "update");
    expect((await setting())?.xmin).toBe(rows[0]?.xmin);
  });

  test("a concurrently unreadable stored row still refuses retained-token writes inside the transaction", async () => {
    await sql`INSERT INTO settings.entries(key,value,updated_at) VALUES(${key},'unreadable-ciphertext',${stamp}::timestamptz)`;
    // Simulate a previously readable preflight; the transactional store must recheck the actual row.
    spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: JSON.stringify(previous) });
    const invalidation = spyOn(settingsCache, "invalidateSettingsCache");
    const before = await state();
    const { token: _token, ...retaining } = input;
    await expect(writeConfiguration(retaining, call)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
    expect(await state()).toEqual(before);
    expect(invalidation).not.toHaveBeenCalled();
  });

  test("explicit unreadable replacement rolls back on audit failure and reset can delete an unreadable override", async () => {
    await sql`INSERT INTO settings.entries(key,value,updated_at) VALUES(${key},'unreadable-ciphertext',${stamp}::timestamptz)`;
    const before = await state();
    await expect(writeConfiguration(input, { ...call, requestId: "configuration-audit-failure" })).rejects.toThrow(
      "configuration audit unavailable",
    );
    expect(await state()).toEqual(before);
    await resetConfiguration(call);
    expect(await setting()).toBeUndefined();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "reset");
  });

  test("delegated calls audit the original person without storing service-account credentials", async () => {
    const delegatedActor: RequestActor = {
      kind: "service_account",
      delegatedUser: user,
      credentialId: "private-credential-id",
      scopes: ["admin"],
      serviceAccount: {
        id: "90000000-0000-4000-8000-000000000001",
        name: "Private service account",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: user.id,
        createdAt: stamp,
      },
    };
    const delegated = { ...call, actor: delegatedActor };
    await writeConfiguration(input, delegated);
    await resetConfiguration(delegated);
    const rows = await events();
    expect(rows).toHaveLength(2);
    expectEvent(rows[0], "update", delegated);
    expectEvent(rows[1], "reset", delegated);
  });
});
