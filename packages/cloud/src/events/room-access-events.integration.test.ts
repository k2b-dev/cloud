import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as auth } from "../../../core/src/migrate/core/auth";
import { migrate as events } from "../../../core/src/migrate/core/events";
import { migrate } from "../../../core/src/migrate/core/room-access-events";
import { migrate as settings } from "../../../core/src/migrate/core/settings";
import { scheduleSessionIdleAccessChanged } from "./app-access";
import { liveOutbox } from "./live-delivery";

databaseSuite()("room access sources use Core's transactional live outbox", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const user = crypto.randomUUID();
  const kid = crypto.randomUUID();
  const sid = crypto.randomUUID();
  beforeAll(async () => {
    database = await useFreshDatabase("room_access");
    await auth();
    await settings();
    await events();
    await migrate();
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${user}::uuid, ${user}, 'local', 'user')`;
    await sql`INSERT INTO auth.signing_keys(purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id, activate_at, activated_at, sign_until, verify_until)
      VALUES ('session', 'active', ${kid}, '{}', 'test', 'test', now(), now(), now() + interval '1 day', now() + interval '2 days')`;
    await sql`INSERT INTO auth.session_families(sid, user_id, auth_epoch, signing_kid, expires_at)
      VALUES (${sid}::uuid, ${user}::uuid, 0, ${kid}, now() + interval '1 day')`;
  });
  afterAll(async () => {
    await database?.drop();
  });
  const due = () => sql<{ payload: { d: { type: string } } }[]>`SELECT payload FROM events.outbox
    WHERE app_id = 'core' AND kind = 'live' AND next_attempt_at <= clock_timestamp()`;
  const clear = () => sql`DELETE FROM events.outbox`;
  // Statement-level sources include sync bulk writes and FK cascades. Exercise
  // each subscribed table, even when a source's write affects no rows.
  for (const [table, column] of [
    ["user_groups_v2", "user_id"],
    ["ipa_user_effective_groups", "group_name"],
    ["group_groups_v2", "parent_group_id"],
    ["group_manager_users_v2", "user_id"],
    ["group_manager_groups_v2", "group_id"],
    ["groups", "name"],
    ["access", "permission"],
    ["service_accounts", "status"],
    ["service_account_groups", "group_id"],
    ["group_manager_service_accounts", "group_id"],
    ["service_account_credentials", "status"],
    ["user_ipa_data", "locked_at"],
    ["users", "auth_epoch"],
    ["session_families", "revoked_at"],
    ["signing_keys", "verify_until"],
  ])
    test(`${table} mutations publish an identity invalidation`, async () => {
      await clear();
      await sql.unsafe(`UPDATE auth.${table} SET ${column} = ${column}`);
      expect((await due()).map((row) => row.payload.d.type)).toEqual(["identity.access.changed"]);
    });
  for (const key of [
    "freeipa.groups.admin",
    "user.session.shared_workstation_idle_minutes",
    "user.category.login.enabled",
    "user.category.guest.enabled",
    "user.category.freeipa.enabled",
  ])
    test(`${key} changes publish an identity invalidation`, async () => {
      await clear();
      await sql`INSERT INTO settings.entries(key, value) VALUES (${key}, 'test') ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;
      expect(await due()).toHaveLength(1);
    });
  test("committed changes coalesce; rolled-back directory locks publish nothing", async () => {
    await clear();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO auth.user_ipa_data(user_id, locked_at) VALUES (${user}::uuid, now())`;
      await tx`UPDATE auth.users SET auth_epoch = auth_epoch + 1 WHERE id = ${user}::uuid`;
    });
    expect(await due()).toHaveLength(1);
    await clear();
    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM auth.user_ipa_data WHERE user_id = ${user}::uuid`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await due()).toHaveLength(0);
  });
  test("profile edits, credential-use accounting and session input emit no immediate invalidations", async () => {
    await clear();
    await sql`UPDATE auth.users SET display_name = 'Room tester' WHERE id = ${user}::uuid`;
    await sql`UPDATE auth.session_families SET last_input_at = now() WHERE sid = ${sid}::uuid`;
    await sql`UPDATE auth.service_account_credentials SET last_used_at = now()`;
    expect(await due()).toHaveLength(0);
  });
  test("account and session expiry publish once when due, renewal replaces their deadlines", async () => {
    await clear();
    await sql`UPDATE auth.users SET account_expires = now() + interval '1 day' WHERE id = ${user}::uuid`;
    await sql`UPDATE auth.session_families SET expires_at = now() + interval '2 days' WHERE sid = ${sid}::uuid`;
    const published: string[] = [];
    const outbox = liveOutbox("core", async (row) => {
      published.push(row.ordering_key);
    });
    await outbox.reconcile();
    expect(published).toEqual(["identity.access", "identity.access"]);
    const deadlines = () => sql`SELECT ordering_key FROM events.outbox ORDER BY ordering_key`;
    expect(await deadlines()).toHaveLength(2);
    await sql`UPDATE auth.users SET account_expires = now() + interval '3 days' WHERE id = ${user}::uuid`;
    await outbox.reconcile();
    expect(await deadlines()).toHaveLength(2);
    // A future first delivery must wait too, independently of the rollout-compatible retry marker.
    await sql`UPDATE events.outbox SET attempts = 0`;
    expect(await outbox.reconcile()).toBe(0);
    await sql`UPDATE events.outbox SET next_attempt_at = now() - interval '1 second'`;
    expect(await outbox.reconcile()).toBe(2);
    expect(published.filter((key) => key.startsWith("identity.deadline."))).toHaveLength(2);
    expect(await outbox.reconcile()).toBe(0);
    await outbox.stop();
  });
  test("idle renewal replaces one durable deadline without an access poll", async () => {
    await clear();
    await sql`UPDATE auth.session_families SET last_input_at = clock_timestamp() - interval '20 seconds' WHERE sid = ${sid}::uuid`;
    await sql.begin((tx) => scheduleSessionIdleAccessChanged(tx, sid, 60));
    await sql.begin((tx) => scheduleSessionIdleAccessChanged(tx, sid, 120));
    const rows = await sql<
      { remaining: number }[]
    >`SELECT extract(epoch FROM next_attempt_at - clock_timestamp())::float8 AS remaining FROM events.outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.remaining).toBeGreaterThan(90);
    expect(rows[0]!.remaining).toBeLessThanOrEqual(100);
    const [exact] = await sql<{ anchored: boolean }[]>`SELECT o.next_attempt_at = sf.last_input_at + interval '120 seconds' AS anchored
      FROM events.outbox o JOIN auth.session_families sf ON sf.sid = ${sid}::uuid`;
    expect(exact?.anchored).toBe(true);
    expect(await due()).toHaveLength(0);
    await sql`UPDATE events.outbox SET next_attempt_at = now() - interval '1 second'`;
    expect((await due())[0]?.payload.d.type).toBe("identity.access.changed");
  });
  test("restarting the migration does not duplicate deadlines", async () => {
    const before = await sql`SELECT id FROM events.outbox ORDER BY seq`;
    await migrate();
    expect(await sql`SELECT id FROM events.outbox ORDER BY seq`).toEqual(before);
  });
  test("concurrent authentications retain one idle deadline; deleting a family cancels it", async () => {
    await clear();
    await Promise.all([60, 120, 180].map((seconds) => sql.begin((tx) => scheduleSessionIdleAccessChanged(tx, sid, seconds))));
    expect(await sql`SELECT id FROM events.outbox`).toHaveLength(1);
    await sql`DELETE FROM auth.session_families WHERE sid = ${sid}::uuid`;
    expect(await sql`SELECT id FROM events.outbox WHERE ordering_key LIKE 'identity.deadline.%'`).toHaveLength(0);
    expect(await due()).toHaveLength(1);
  });
});
