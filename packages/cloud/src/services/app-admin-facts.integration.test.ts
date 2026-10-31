import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "../../../core/src/migrate/core/app-events";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateNotifications } from "../../../core/src/migrate/core/notifications";
import type { RequestAuthority } from "../server/middleware/auth";
import { appAccessManagers } from "./app-access-management";
import { appAdminFacts } from "./app-admin-facts";
import { createAppDetailsService } from "./app-details";
import { buildProjectedUser } from "./session/user";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const authority = (admin = true): RequestAuthority => {
  const user = buildProjectedUser({ id: id(1), provider: "local", profile: "user", effective_admin: admin });
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] };
};

test("administrator authority is required even for an empty or oversized batch", async () => {
  for (const caller of [authority(false), { ...authority(), credentialKind: "oauth" as const, scopes: ["read"] }]) {
    for (const ids of [[], ["facts-a"], Array.from({ length: 501 }, () => "facts-a")]) {
      await expect(appAdminFacts(caller, ids)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    }
  }
});

test("empty batches return immediately and the 500 input ID limit includes duplicates", async () => {
  expect(await appAdminFacts(authority(), [])).toEqual(new Map());
  await expect(
    appAdminFacts(
      authority(),
      Array.from({ length: 501 }, () => "facts-a"),
    ),
  ).rejects.toMatchObject({
    code: "TOO_MANY_APPS",
    status: 400,
  });
});

let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("app_admin_facts");
  await migrateAuth();
  await migrateEvents();
  await migrateAppEvents();
  await migrateNotifications();
  setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
}, 30_000);
afterAll(async () => {
  setSystemTime();
  if (database) {
    await sql.close();
    await database.drop();
  }
});

suiteFor("database")("batched app administration facts", () => {
  test("all fact families stay app-scoped and agree with access and detail reads", async () => {
    await sql`
      INSERT INTO auth.users(id, uid, provider, profile, display_name, account_expires)
      VALUES (${id(1)}, 'facts-person', 'local', 'user', 'Facts Person', NULL),
        (${id(2)}, 'facts-expired', 'local', 'user', 'Expired Person', now() - interval '1 day')
    `;
    await sql`
      INSERT INTO auth.groups(id, cn, provider, name)
      VALUES (${id(3)}, 'facts-parent', 'local', 'Facts Parent'),
        (${id(4)}, 'facts-child', 'local', 'Facts Child'), (${id(5)}, 'facts-empty', 'local', 'Facts Empty')
    `;
    await sql`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES (${id(1)}, ${id(4)})`;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${id(3)}, ${id(4)})`;
    await sql`
      INSERT INTO auth.service_accounts(id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_at)
      VALUES (${id(10)}, 'App A', 'resource_bound', 'active', NULL, 'facts-a', 'cloud.app', 'facts-a', '2024-01-01Z'),
        (${id(11)}, 'App B', 'resource_bound', 'disabled', NULL, 'facts-b', 'cloud.app', 'facts-b', '2024-02-01Z'),
        (${id(12)}, 'Standalone', 'standalone', 'active', NULL, NULL, NULL, NULL, '2024-03-01Z'),
        (${id(13)}, 'Agent', 'agent', 'active', NULL, NULL, NULL, NULL, '2024-03-01Z'),
        (${id(14)}, 'Disabled', 'standalone', 'disabled', NULL, NULL, NULL, NULL, '2024-03-01Z'),
        (${id(15)}, 'Delegated', 'user_delegated', 'active', ${id(1)}, NULL, NULL, NULL, '2024-03-01Z'),
        (${id(16)}, 'Other resource', 'resource_bound', 'active', NULL, 'facts-a', 'document', 'facts-a', '2020-01-01Z'),
        (${id(17)}, 'Mismatched resource', 'resource_bound', 'active', NULL, 'facts-a', 'cloud.app', 'other', '2020-01-01Z')
    `;
    await sql`INSERT INTO auth.app_access_state(app_id, configured_at)
      VALUES ('facts-a', '2025-01-01Z'), ('facts-b', NULL)`;
    await sql`
      INSERT INTO auth.access(id, user_id, group_id, service_account_id, authenticated_only, permission, created_at)
      VALUES (${id(20)}, ${id(1)}, NULL, NULL, false, 'admin', '2023-01-01Z'),
        (${id(21)}, ${id(2)}, NULL, NULL, false, 'admin', '2025-01-01Z'),
        (${id(22)}, NULL, ${id(3)}, NULL, false, 'admin', '2025-01-01Z'),
        (${id(23)}, NULL, ${id(5)}, NULL, false, 'admin', '2025-01-01Z'),
        (${id(24)}, NULL, NULL, ${id(10)}, false, 'admin', '2025-01-01Z'),
        (${id(25)}, NULL, NULL, ${id(12)}, false, 'admin', '2025-01-01Z'),
        (${id(26)}, NULL, NULL, ${id(13)}, false, 'admin', '2025-01-01Z'),
        (${id(27)}, NULL, NULL, ${id(14)}, false, 'admin', '2025-01-01Z'),
        (${id(28)}, NULL, NULL, ${id(15)}, false, 'admin', '2025-01-01Z'),
        (${id(29)}, NULL, NULL, NULL, true, 'read', '2025-01-01Z'),
        (${id(30)}, NULL, NULL, NULL, false, 'read', '2025-01-01Z')
    `;
    await sql`INSERT INTO auth.app_access(app_id, access_id)
      SELECT 'facts-a', id FROM auth.access WHERE id IN ${sql(Array.from({ length: 11 }, (_, n) => id(20 + n)))}`;
    await sql`
      INSERT INTO auth.service_account_credentials(id, service_account_id, name, kind, status,
        public_key, fingerprint, created_at, expires_at, revoked_at, last_used_at)
      VALUES (${id(40)}, ${id(10)}, 'Active', 'app_key', 'active', ${"A".repeat(43)}, ${"a".repeat(32)},
          '2024-04-01Z', NULL, NULL, '2026-01-01Z'),
        (${id(41)}, ${id(10)}, 'Expired', 'app_key', 'active', ${"B".repeat(43)}, ${"b".repeat(32)},
          '2024-05-01Z', now() - interval '1 day', NULL, '2026-02-01Z'),
        (${id(42)}, ${id(10)}, 'Revoked and expired', 'app_key', 'revoked', ${"C".repeat(43)}, ${"c".repeat(32)},
          '2024-06-01Z', now() - interval '1 day', '2026-01-01Z', '2026-03-01Z'),
        (${id(43)}, ${id(11)}, 'Disabled account key', 'app_key', 'active', ${"D".repeat(43)}, ${"d".repeat(32)},
          '2024-07-01Z', now() + interval '1 day', NULL, NULL)
    `;
    await sql`
      INSERT INTO auth.service_account_credentials(service_account_id, name, kind, status,
        token_prefix, secret_hash, expires_at, revoked_at, created_at, last_used_at)
      VALUES (${id(10)}, 'Active token', 'api_token', 'active', 'facts-active', 'fixture', NULL, NULL, '2024-01-02Z', '2026-04-01Z'),
        (${id(10)}, 'Expired token', 'api_token', 'active', 'facts-expired', 'fixture', now() - interval '1 day', NULL, '2024-01-03Z', NULL),
        (${id(10)}, 'Revoked token', 'api_token', 'revoked', 'facts-revoked', 'fixture', NULL, '2026-01-01Z', '2024-01-04Z', NULL),
        (${id(11)}, 'Disabled account token', 'api_token', 'active', 'facts-disabled', 'fixture', NULL, NULL, '2024-02-02Z', NULL),
        (${id(16)}, 'Other resource token', 'api_token', 'active', 'facts-other', 'fixture', NULL, NULL, '2020-01-02Z', NULL),
        (${id(17)}, 'Mismatched token', 'api_token', 'active', 'facts-mismatched', 'fixture', NULL, NULL, '2020-01-02Z', NULL),
        (${id(12)}, 'Standalone token', 'api_token', 'active', 'facts-standalone', 'fixture', NULL, NULL, '2020-01-02Z', NULL)
    `;
    await sql`
      INSERT INTO events.app_declarations(app_id, type, version, subject, automation, title, description, data_schema, schema_hash, retired_at)
      VALUES ('facts-a', 'facts-a.changed', 1, 'item', true, 'Changed', 'Changed', '{}', 'fixture', NULL),
        ('facts-a', 'facts-a.changed', 2, 'item', true, 'Changed v2', 'Changed', '{}', 'fixture', NULL),
        ('facts-a', 'facts-a.retired', 1, 'item', true, 'Retired', 'Retired', '{}', 'fixture', now()),
        ('facts-b', 'facts-b.changed', 1, 'item', true, 'Changed', 'Changed', '{}', 'fixture', NULL)
    `;
    await sql`
      INSERT INTO events.app_subscriptions(id, app_id, event_type, version, state)
      VALUES ('a-active', 'facts-a', 'facts-a.changed', 1, 'active'),
        ('a-blocked', 'facts-a', 'unknown.changed', 1, 'blocked'),
        ('a-cancelled', 'facts-a', 'old.changed', 1, 'cancelled'),
        ('b-active', 'facts-b', 'facts-a.changed', 1, 'active')
    `;
    for (const [index, subscription, state] of [
      [0, "a-active", "failed"],
      [1, "a-active", "pending"],
      [2, "a-active", "retrying"],
      [3, "a-active", "done"],
      [4, "a-active", "cancelled"],
      [5, "a-blocked", "failed"],
      [6, "a-cancelled", "failed"],
      [7, "b-active", "failed"],
      [8, "b-active", "pending"],
    ] as const) {
      await sql`INSERT INTO events.app_events(id, type, version, source, subject_key, envelope, state)
        VALUES (${id(100 + index)}, 'facts-a.changed', 1, 'facts-a', 'item', '{}', 'accepted')`;
      await sql`INSERT INTO events.app_deliveries(id, event_id, subscription_id, subject_key, state)
        VALUES (${id(200 + index)}, ${id(100 + index)}, ${subscription}, 'item', ${state})`;
    }
    await sql`
      INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind, active)
      VALUES ('facts-a.one', 'facts-a', 'one', 'One', 'One', 'user', true),
        ('facts-a.two', 'facts-a', 'two', 'Two', 'Two', 'email', true),
        ('facts-a.old', 'facts-a', 'old', 'Old', 'Old', 'user', false),
        ('facts-b.one', 'facts-b', 'one', 'One', 'One', 'user', true)
    `;

    const facts = await appAdminFacts(authority(), ["facts-a", "facts-b", "unknown", "facts-a"]);
    expect([...facts.keys()]).toEqual(["facts-a", "facts-b", "unknown"]);
    expect(facts.get("facts-a")).toEqual({
      access: { people: 2, groups: 2, serviceAccounts: 5, managers: 4, configured: true },
      keys: {
        active: 1,
        expired: 1,
        revoked: 1,
        lastUsedAt: "2026-03-01T00:00:00.000Z",
        firstCreatedAt: "2024-04-01T00:00:00.000Z",
        accountStatus: "active",
      },
      tokens: { active: 1, total: 3 },
      events: { hears: 1, sends: 2, failedDeliveries: 3, waitingDeliveries: 2 },
      notifications: 2,
      firstKnownAt: "2023-01-01T00:00:00.000Z",
    });
    expect(facts.get("facts-b")).toEqual({
      access: { people: 0, groups: 0, serviceAccounts: 0, managers: 0, configured: false },
      keys: { active: 1, expired: 0, revoked: 0, lastUsedAt: null, firstCreatedAt: "2024-07-01T00:00:00.000Z", accountStatus: "disabled" },
      tokens: { active: 1, total: 1 },
      events: { hears: 1, sends: 1, failedDeliveries: 1, waitingDeliveries: 1 },
      notifications: 1,
      firstKnownAt: "2024-02-01T00:00:00.000Z",
    });
    expect(facts.get("unknown")).toEqual({
      access: null,
      keys: { active: 0, expired: 0, revoked: 0, lastUsedAt: null, firstCreatedAt: null, accountStatus: null },
      tokens: { active: 0, total: 0 },
      events: { hears: 0, sends: 0, failedDeliveries: 0, waitingDeliveries: 0 },
      notifications: 0,
      firstKnownAt: null,
    });
    expect(facts.get("facts-a")?.access?.managers).toBe((await appAccessManagers("facts-a")).length);
    const details = createAppDetailsService({ getApp: async () => null, capabilities: async () => [] });
    for (const appId of ["facts-a", "facts-b"]) {
      const detail = await details(appId, { authority: authority() });
      expect(detail).not.toBeNull();
      expect(facts.get(appId)?.events.sends).toBe(detail?.totals.sends);
      expect(facts.get(appId)?.events.hears).toBe(detail?.hears.filter((subscription) => subscription.state === "active").length);
      expect(facts.get(appId)?.events.failedDeliveries).toBe(
        detail?.hears.reduce((sum, subscription) => sum + subscription.counts.failed, 0),
      );
      expect(facts.get(appId)?.events.waitingDeliveries).toBe(
        detail?.hears.reduce((sum, subscription) => sum + subscription.counts.pending + subscription.counts.retrying, 0),
      );
      expect(facts.get(appId)?.notifications).toBe(detail?.totals.notifications);
    }

    await sql`DELETE FROM auth.app_access_state WHERE app_id = 'facts-b'`;
    await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id(11)}`;
    const accountOnly = (await appAdminFacts(authority(), ["facts-b"])).get("facts-b");
    expect(accountOnly?.access).toBeNull();
    expect(accountOnly?.keys).toEqual({
      active: 0,
      expired: 0,
      revoked: 0,
      lastUsedAt: null,
      firstCreatedAt: null,
      accountStatus: "disabled",
    });
    expect(accountOnly?.tokens).toEqual({ active: 0, total: 0 });
    expect(accountOnly?.firstKnownAt).toBe("2024-02-01T00:00:00.000Z");

    await sql`DELETE FROM auth.service_accounts WHERE id = ${id(11)}`;
    await sql`INSERT INTO auth.app_access_state(app_id, configured_at) VALUES ('facts-b', '2022-01-01Z')`;
    expect((await appAdminFacts(authority(), ["facts-b"])).get("facts-b")?.firstKnownAt).toBe("2022-01-01T00:00:00.000Z");
    await sql`UPDATE auth.app_access_state SET configured_at = NULL WHERE app_id = 'facts-b'`;
    const unconfigured = (await appAdminFacts(authority(), ["facts-b"])).get("facts-b");
    expect(unconfigured?.firstKnownAt).toBeNull();
    expect(unconfigured?.access).toEqual({ people: 0, groups: 0, serviceAccounts: 0, managers: 0, configured: false });

    // Historic duplicate app-bound accounts still contribute credentials; the oldest owns account status.
    await sql`INSERT INTO auth.service_accounts(id, name, kind, status, app_id, resource_type, resource_id, created_at)
      VALUES (${id(18)}, 'Duplicate app A', 'resource_bound', 'disabled', 'facts-a', 'cloud.app', 'facts-a', '2025-01-01Z')`;
    await sql`INSERT INTO auth.service_account_credentials(service_account_id, name, kind, public_key, fingerprint, created_at)
      VALUES (${id(18)}, 'Duplicate account key', 'app_key', ${"E".repeat(43)}, ${"e".repeat(32)}, '2025-02-01Z')`;
    const duplicate = (await appAdminFacts(authority(), ["facts-a"])).get("facts-a");
    expect(duplicate?.keys).toMatchObject({ active: 2, expired: 1, revoked: 1, accountStatus: "active" });
    expect(duplicate?.tokens).toEqual({ active: 1, total: 3 });
    expect(
      (
        await appAdminFacts(
          authority(),
          Array.from({ length: 500 }, () => "facts-a"),
        )
      ).size,
    ).toBe(1);
  });
});
