import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createPosixService } from "./posix";
import { mirrorIpaPosix } from "../ipa/posix";
import { set } from "../settings";
import { migratePosix } from "../../../../core/src/migrate/core/posix";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";

const url = process.env.CLOUD_POSIX_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const admin = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] };
const config = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };

suite("isolated Linux identity migration and provisioning", () => {
  let db: SQL;
  let service: ReturnType<typeof createPosixService>;
  const createUser = async (uid: string, provider = "local", profile = "user") => {
    const [row] = await db<
      { id: string }[]
    >`INSERT INTO auth.users(uid, provider, profile) VALUES (${uid}, ${provider}, ${profile}) RETURNING id`;
    return row!.id;
  };
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url || !new URL(url).pathname.startsWith("/cloud_posix_test"))
      throw new Error("Both database URLs must point to the same dedicated cloud_posix_test database");
    db = new SQL(url);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), uid TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '')`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.user_ipa_data(user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, uid_number INTEGER)`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.groups(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), cn TEXT UNIQUE NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, gid_number INTEGER, UNIQUE(provider,name))`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, group_id UUID REFERENCES auth.groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id,group_id))`.simple();
    await db`CREATE TABLE IF NOT EXISTS settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`.simple();
    await migratePosix(db);
    await migrateAudit();
    service = createPosixService(db, async () => [{ start: 1000000, end: 1999999 }]);
  });
  beforeEach(async () => {
    await db`TRUNCATE auth.user_posix, auth.posix_allocations, auth.user_groups_v2, auth.user_ipa_data, auth.groups, auth.users, settings.entries, audit.events CASCADE`.simple();
    await set("linux.identity_config", JSON.stringify(config), db);
  });
  afterAll(async () => {
    await db?.close();
  });

  test("migration is additive and idempotent; preview never provisions", async () => {
    const id = await createUser("alice");
    await migratePosix(db);
    await migratePosix(db);
    expect((await service.get(admin, id)).user.state).toBe("ready");
    expect(await db`SELECT * FROM auth.posix_allocations`).toHaveLength(0);
  });
  test("concurrent provisioning produces one stable identity and primary group", async () => {
    const id = await createUser("alice");
    const results = await Promise.all(Array.from({ length: 5 }, () => service.provision(admin, id)));
    expect(new Set(results.map((result) => result.identity?.uidNumber)).size).toBe(1);
    expect(results[0]!.identity).toMatchObject({
      uidNumber: 200000,
      primaryGidNumber: 200000,
      homeDirectory: "/home/alice",
      loginShell: "/bin/bash",
    });
    expect(await db`SELECT * FROM auth.groups`).toHaveLength(1);
    expect(await db`SELECT * FROM auth.user_groups_v2`).toHaveLength(1);
  });
  test("different users allocate distinct IDs; deletion cannot reuse them", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const results = await Promise.all([service.provision(admin, alice), service.provision(admin, bob)]);
    expect(new Set(results.map((result) => result.identity?.uidNumber)).size).toBe(2);
    await db`DELETE FROM auth.users WHERE id = ${alice}::uuid`;
    const carol = await createUser("carol");
    expect((await service.provision(admin, carol)).identity?.uidNumber).toBe(200002);
  });
  test("a referenced primary group cannot be deleted", async () => {
    const alice = await createUser("alice");
    await service.provision(admin, alice);
    await expect(
      (async () => {
        await db`DELETE FROM auth.groups WHERE id = (SELECT primary_group_id FROM auth.user_posix WHERE user_id = ${alice}::uuid)`;
      })(),
    ).rejects.toThrow();
    expect((await service.get(admin, alice)).user.state).toBe("prepared");
  });
  test("rejects guests, invalid names and existing group names", async () => {
    const guest = await createUser("guest", "local", "guest");
    await expect(service.provision(admin, guest)).rejects.toThrow("guest");
    const invalid = await createUser("Invalid.Name");
    await expect(service.provision(admin, invalid)).rejects.toThrow("invalid_name");
    const alice = await createUser("alice");
    await db`INSERT INTO auth.groups(cn, name, provider) VALUES ('local:alice','alice','local')`;
    await expect(service.provision(admin, alice)).rejects.toThrow("group_conflict");
    expect(await db`SELECT * FROM auth.posix_allocations`).toHaveLength(0);
  });
  test("range conflict fails closed and leaves no partial identity", async () => {
    const id = await createUser("alice");
    const conflicting = createPosixService(db, async () => [{ start: 199000, end: 200010 }]);
    await expect(conflicting.provision(admin, id)).rejects.toThrow("ipa_range_conflict");
    const ipa = await createUser("ipauser", "ipa");
    await db`INSERT INTO auth.user_ipa_data(user_id, uid_number) VALUES (${ipa}::uuid, 200001)`;
    await expect(service.provision(admin, id)).rejects.toThrow("ipa_range_conflict");
    expect(await db`SELECT * FROM auth.posix_allocations`).toHaveLength(0);
  });
  test("disabled configuration is rechecked; existing identities remain visible", async () => {
    const alice = await createUser("alice");
    await service.provision(admin, alice);
    await set("linux.identity_config", JSON.stringify({ ...config, enabled: false }), db);
    const bob = await createUser("bob");
    await expect(service.provision(admin, bob)).rejects.toThrow("setup_disabled");
    expect((await service.get(admin, alice)).user.identity?.uidNumber).toBe(200000);
  });
  test("defaults are materialized; overrides cannot change numeric identity", async () => {
    const alice = await createUser("alice");
    await service.provision(admin, alice);
    await set("linux.identity_config", JSON.stringify({ ...config, homeTemplate: "/srv/{username}" }), db);
    expect((await service.get(admin, alice)).user.identity?.homeDirectory).toBe("/home/alice");
    const changed = await service.update(admin, alice, { homeDirectory: "/srv/alice", loginShell: "/bin/zsh" });
    expect(changed.identity).toMatchObject({ uidNumber: 200000, homeDirectory: "/srv/alice" });
    await expect(service.update(admin, alice, { homeDirectory: "/../root", loginShell: "/bin/bash" })).rejects.toThrow("invalid_paths");
  });
  test("IPA mirroring preserves exact values, missing fields and provenance", async () => {
    const id = await createUser("ipauser", "ipa");
    const identity = {
      userId: id,
      uidNumber: 1234567,
      primaryGidNumber: 1234568,
      homeDirectory: "/srv/ipa/ipauser",
      loginShell: "/bin/zsh",
    };
    await mirrorIpaPosix(db, identity);
    await mirrorIpaPosix(db, identity);
    expect((await service.get(admin, id)).user.identity).toEqual({ ...identity, managedBy: "ipa" });
    await mirrorIpaPosix(db, { ...identity, loginShell: null });
    expect((await service.get(admin, id)).user.state).toBe("ipa_pending");
    await expect(service.update(admin, id, { homeDirectory: "/home/ipauser", loginShell: "/bin/bash" })).rejects.toThrow(
      "identity_not_locally_managed",
    );
    await db`UPDATE auth.users SET provider = 'local' WHERE id = ${id}::uuid`;
    expect((await service.get(admin, id)).user.state).toBe("provider_changed");
    await expect(service.provision(admin, id)).rejects.toThrow("provider_changed");
  });
  test("legacy IPA identity remains readable before the next full sync", async () => {
    const id = await createUser("ipauser", "ipa");
    await db`INSERT INTO auth.user_ipa_data(user_id,uid_number) VALUES (${id}::uuid,1234567)`;
    expect((await service.get(admin, id)).user).toMatchObject({ state: "ipa_pending", identity: { uidNumber: 1234567, loginShell: null } });
  });
  test("range exhaustion rolls back the entire user and group allocation", async () => {
    await set("linux.identity_config", JSON.stringify({ ...config, rangeEnd: 200000 }), db);
    await service.provision(admin, await createUser("alice"));
    await expect(service.provision(admin, await createUser("bob"))).rejects.toThrow("range_exhausted");
    expect(await db`SELECT * FROM auth.posix_allocations`).toHaveLength(2);
    expect(await db`SELECT * FROM auth.groups`).toHaveLength(1);
  });
  test("service authorization protects reads and writes outside HTTP", async () => {
    const actor = { ...admin, roles: ["user"] };
    await expect(service.overview(actor)).rejects.toThrow("admin_required");
    await expect(service.configure(actor, config)).rejects.toThrow("admin_required");
    await expect(service.provision(actor, crypto.randomUUID())).rejects.toThrow("admin_required");
  });
  test("existing local groups receive one stable GID and an audit event", async () => {
    const [group] = await db<
      { id: string }[]
    >`INSERT INTO auth.groups(cn,name,provider) VALUES ('local:staff','staff','local') RETURNING id`;
    const first = await service.provisionGroup(admin, group!.id);
    expect(await service.provisionGroup(admin, group!.id)).toEqual(first);
    const events = await db`SELECT * FROM audit.events WHERE action = 'accounts.linux.provision_group'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_user_id).toBe(admin.id);
  });
  test("configuration validates directory ranges before committing", async () => {
    expect(await service.configure(admin, { ...config, homeTemplate: "/srv/{username}" })).toMatchObject({
      homeTemplate: "/srv/{username}",
    });
    const invalid = createPosixService(db, async () => [{ start: 200050, end: 200150 }]);
    await expect(invalid.configure(admin, config)).rejects.toThrow("ipa_range_conflict");
    expect((await service.overview(admin)).config.homeTemplate).toBe("/srv/{username}");
  });
  test("flags duplicate numeric identities without rewriting them", async () => {
    const alice = await createUser("alice", "ipa");
    const bob = await createUser("bob", "ipa");
    for (const userId of [alice, bob])
      await mirrorIpaPosix(db, {
        userId,
        uidNumber: 1234567,
        primaryGidNumber: 1234568,
        homeDirectory: "/home/test",
        loginShell: "/bin/bash",
      });
    expect((await service.get(admin, alice)).user.state).toBe("identity_conflict");
    expect((await service.get(admin, bob)).user.identity?.uidNumber).toBe(1234567);
  });
  test("retained guest identities are not eligible; unknown IPA ranges fail closed", async () => {
    const alice = await createUser("alice");
    await service.provision(admin, alice);
    await db`UPDATE auth.users SET profile = 'guest' WHERE id = ${alice}::uuid`;
    expect((await service.get(admin, alice)).user.state).toBe("guest");
    await expect(service.provision(admin, alice)).rejects.toThrow("guest");
    await createUser("ipauser", "ipa");
    const offline = createPosixService(db, async () => []);
    await expect(offline.configure(admin, config)).rejects.toThrow("ipa_inventory_unavailable");
  });
});
