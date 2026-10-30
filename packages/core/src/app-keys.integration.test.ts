import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAdminAppKeyRoutes } from "@k2b/cloud/api";
import { appKeyFingerprint } from "@k2b/cloud/app-key";
import type { User } from "@k2b/cloud/contracts/shared";
import { appKeys, getActiveAppKey, getInstallationId, touchAppKey } from "@k2b/cloud/services/app-keys";
import { serviceAccountCredentials } from "@k2b/cloud/services/service-account-credentials";
import { SQL, sql } from "bun";
import { APP_KEY_FIXTURES } from "../../../scripts/fixtures/app-key-fixtures";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrateAppKeys } from "./migrate/core/app-keys";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateAuth } from "./migrate/core/auth";

const actor: User = {
  id: "33333333-3333-4333-8333-333333333333",
  uid: "app-key-admin",
  provider: "local",
  profile: "user",
  roles: ["admin"],
  givenname: "",
  sn: "",
  displayName: "Admin",
  mail: null,
  avatarHash: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
};
const first = APP_KEY_FIXTURES[0],
  second = APP_KEY_FIXTURES[1],
  third = APP_KEY_FIXTURES[2];

databaseSuite()("Core app-key registry and admin API", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("cloud_app_keys");
    await migrateAuth();
    await migrateAudit();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, admin) VALUES (${actor.id}::uuid, ${actor.uid}, 'local', 'user', true)`;
  });
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });

  const register = (appId: string, publicKey: string) => appKeys.register({ actor, appId, publicKey });
  const routes = createAdminAppKeyRoutes(async (c, next) => {
    c.set("user", actor);
    await next();
  });
  const post = (appId: string, publicKey: string) =>
    routes.request(`/${appId}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey, name: "Deployment" }),
    });

  test("installation ID is one durable DB row across repeat migrations", async () => {
    const before = await getInstallationId();
    await migrateAppKeys();
    await migrateAppKeys();
    expect(await getInstallationId()).toBe(before);
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.installation`;
    expect(row?.count).toBe(1);
    const response = await routes.request("/keys");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installationId: before });
  });

  test("repeat migrations do not take exclusive locks on credential traffic", async () => {
    const connection = new SQL(database.url);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = connection.begin(async (db) => {
      await db`LOCK TABLE auth.service_account_credentials IN ROW EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const migration = (async () => {
      await held.promise;
      await migrateAppKeys();
    })();
    try {
      await Promise.race([
        migration,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Repeat migration blocked credential writes")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await writer;
      await migration;
      await connection.close();
    }
  });

  test("API enrolls a stopped third-party app idempotently and never returns private material", async () => {
    const response = await post("not-yet-installed", first.publicKey);
    expect(response.status).toBe(200);
    const key = await response.json();
    const retry = await post("not-yet-installed", first.publicKey);
    expect(await retry.json()).toEqual(key);
    expect(key).toMatchObject({ installationId: await getInstallationId(), fingerprint: first.fingerprint });
    const [account] = await sql<{ kind: string; app_id: string; resource_type: string; resource_id: string; name: string }[]>`
      SELECT kind, app_id, resource_type, resource_id, name FROM auth.service_accounts WHERE app_id = 'not-yet-installed'
    `;
    expect(account).toEqual({
      kind: "resource_bound",
      app_id: "not-yet-installed",
      resource_type: "cloud.app",
      resource_id: "not-yet-installed",
      name: "not-yet-installed workload",
    });
    const listing = await (await routes.request("/not-yet-installed/keys")).json();
    expect(listing.items).toHaveLength(1);
    const beyond = await appKeys.list({ actor, appId: "not-yet-installed", page: 2, perPage: 100 });
    expect(beyond.ok && beyond.data).toMatchObject({ items: [], total: 1, hasNext: false });
    expect(listing.items[0]).toMatchObject({
      publicKey: first.publicKey,
      fingerprint: first.fingerprint,
      status: "active",
      createdBy: actor.id,
      lastUsedAt: null,
    });
    expect(JSON.stringify(listing)).not.toContain(first.seed);
    expect(Object.keys(listing.items[0])).not.toContain("secretHash");
    const overview = await (await routes.request("/keys")).json();
    expect(overview.items).toContainEqual({ appId: "not-yet-installed", accountStatus: "active", totalKeys: 1, activeKeys: 1 });
    const [audit] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM audit.events WHERE action = 'app_key.create' AND target_id = ${key.keyId}`;
    expect(audit?.count).toBe(1);
    // Bearer-key APIs keep their existing token-only contract.
    const bearerList = await serviceAccountCredentials.listOverview({ filter: { appId: "not-yet-installed" } });
    expect(bearerList.items).toHaveLength(0);
    const bearerRevoke = await serviceAccountCredentials.revoke({ actor, credentialId: key.keyId });
    expect(!bearerRevoke.ok && bearerRevoke.error.status).toBe(404);
    expect(await getActiveAppKey({ appId: "not-yet-installed", keyId: key.keyId })).not.toBeNull();
  });

  test("concurrent distinct creates cannot exceed two active keys, while concurrent repeats return one key", async () => {
    const results = await Promise.all([first, second, third].map((key) => register("concurrent", key.publicKey)));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    const failed = results.find((result) => !result.ok);
    expect(failed && !failed.ok && failed.error.status).toBe(409);
    const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id WHERE sa.app_id = 'concurrent' AND c.kind = 'app_key' AND c.status = 'active'`;
    expect(count?.count).toBe(2);
    const repeated = await Promise.all([1, 2, 3, 4].map(() => register("concurrent-repeat", first.publicKey)));
    expect(repeated.every((result) => result.ok)).toBe(true);
    expect(new Set(repeated.flatMap((result) => (result.ok ? [result.data.keyId] : []))).size).toBe(1);
    const full = await post("concurrent", (results[0]?.ok ? (results[1]?.ok ? third : second) : first).publicKey);
    expect(full.status).toBe(409);
  });

  test("revocation is immediate to direct DB readers, idempotent, app-bound and never reactivated by retry", async () => {
    const registered = await register("revocation", first.publicKey);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const coordinates = { appId: "revocation", keyId: registered.data.keyId };
    expect(await getActiveAppKey(coordinates)).not.toBeNull();
    await touchAppKey(coordinates);
    expect((await getActiveAppKey(coordinates))?.lastUsedAt).not.toBeNull();
    expect((await appKeys.revoke({ ...coordinates, actor, appId: "another-app" })).ok).toBe(false);
    const response = await routes.request(`/revocation/keys/${coordinates.keyId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect((await routes.request(`/revocation/keys/${coordinates.keyId}`, { method: "DELETE" })).status).toBe(200);
    expect(await getActiveAppKey(coordinates)).toBeNull();
    const [row] = await sql<{ status: string; revoked_at: Date | null; revoked_by: string; last_used_at: Date }[]>`
      SELECT status, revoked_at, revoked_by, last_used_at FROM auth.service_account_credentials WHERE id = ${coordinates.keyId}::uuid`;
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_by).toBe(actor.id);
    expect(row?.revoked_at).not.toBeNull();
    await touchAppKey(coordinates);
    const [untouched] = await sql<
      { last_used_at: Date }[]
    >`SELECT last_used_at FROM auth.service_account_credentials WHERE id = ${coordinates.keyId}::uuid`;
    expect(untouched?.last_used_at).toEqual(row?.last_used_at);
    const repeated = await register("revocation", first.publicKey);
    expect(repeated.ok && repeated.data).toEqual({ ...registered.data, status: "revoked" });
    expect(await getActiveAppKey(coordinates)).toBeNull();
    expect(await getActiveAppKey({ ...coordinates, keyId: "-".repeat(36) })).toBeNull();
    const listed = await appKeys.list({ actor, appId: "revocation" });
    expect(listed.ok && listed.data.items[0]?.status).toBe("revoked");
    const [audit] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM audit.events WHERE action = 'app_key.revoke' AND target_id = ${coordinates.keyId}`;
    expect(audit?.count).toBe(1);
    const [revocation] = await sql`SELECT metadata FROM audit.events WHERE action = 'app_key.revoke' AND target_id = ${coordinates.keyId}`;
    const activeAccount = await appKeys.list({ actor, appId: "revocation" });
    expect(revocation?.metadata.serviceAccountId).toBe(activeAccount.ok && activeAccount.data.items[0]?.serviceAccountId);
  });

  test("expiry frees a slot; disabled accounts stay disabled; oauth is enrollable; invalid keys/IDs are rejected", async () => {
    const key = await register("expiry", first.publicKey);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    await sql`UPDATE auth.service_account_credentials SET expires_at = now() - interval '1 minute' WHERE id = ${key.data.keyId}::uuid`;
    expect(await getActiveAppKey({ appId: "expiry", keyId: key.data.keyId })).toBeNull();
    expect((await register("expiry", second.publicKey)).ok).toBe(true);
    expect((await register("expiry", third.publicKey)).ok).toBe(true);
    const listing = await appKeys.list({ actor, appId: "expiry" });
    expect(listing.ok && listing.data.items.filter((item) => item.status === "expired")).toHaveLength(1);
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE app_id = 'expiry'`;
    expect(await getActiveAppKey({ appId: "expiry", keyId: key.data.keyId })).toBeNull();
    const repeated = await register("expiry", second.publicKey);
    expect(repeated.ok && repeated.data.accountStatus).toBe("disabled");
    expect((await appKeys.list({ actor, appId: "expiry" })).ok).toBe(true);
    const disabledKeys = await appKeys.list({ actor, appId: "expiry" });
    expect(disabledKeys.ok && disabledKeys.data.items.every((item) => item.accountStatus === "disabled")).toBe(true);
    const overview = await appKeys.listApps({ actor });
    expect(overview.ok && overview.data.items.find((item) => item.appId === "expiry")?.accountStatus).toBe("disabled");
    const newDisabled = await register("disabled-new", first.publicKey);
    expect(newDisabled.ok).toBe(true);
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE app_id = 'disabled-new'`;
    const refused = await register("disabled-new", second.publicKey);
    expect(!refused.ok && refused.error.status).toBe(409);
    const [account] = await sql<{ status: string }[]>`SELECT status FROM auth.service_accounts WHERE app_id = 'expiry'`;
    expect(account?.status).toBe("disabled");
    expect((await register("oauth", first.publicKey)).ok).toBe(true);
    for (const id of ["core", "gateway", "Bad", "a_b", "a".repeat(81)]) expect((await register(id, first.publicKey)).ok).toBe(false);
    for (const value of ["A".repeat(43), "_".repeat(43), first.publicKey + "="]) expect((await register("bad-key", value)).ok).toBe(false);
    expect(await appKeyFingerprint(first.publicKey)).toBe(first.fingerprint);
  });
});
