import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import type { RequestActor, UserProvider } from "../../contracts/shared";
import { buildProjectedUser } from "../session/user";
import { encryptValue } from "../settings/crypto";
import { createAccountIdentityService } from "./identities";

const suite = databaseSuite();
suite("public account identity reads against isolated Postgres", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let service: ReturnType<typeof createAccountIdentityService>;
  const config = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };
  const setting = async (key: string, value: unknown) => {
    const encrypted = await encryptValue(value);
    await db`INSERT INTO settings.entries(key,value) VALUES(${key},${encrypted}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  };
  const user = async (uid: string, provider: UserProvider = "local", admin = false): Promise<RequestActor & { kind: "user" }> => {
    const [row] = await db<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${uid},${provider},'user',${admin}) RETURNING id`;
    return { kind: "user", user: buildProjectedUser({ id: row!.id, uid, provider, profile: "user", effective_admin: admin }) };
  };
  const group = async (name: string, provider: UserProvider = "local", gid: number | null = null) => {
    const [row] = await db<
      { id: string }[]
    >`INSERT INTO auth.groups(name,provider,gid_number) VALUES(${name},${provider},${gid}) RETURNING id`;
    return row!.id;
  };
  beforeAll(async () => {
    disposable = await createDisposableDatabase("identities");
    db = new SQL(disposable.url);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uid text UNIQUE NOT NULL, provider text NOT NULL, profile text NOT NULL, admin boolean NOT NULL DEFAULT false, account_expires timestamptz)`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, managed_by text, uid_number integer, primary_gid_number integer, primary_group_id uuid)`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, provider text NOT NULL, gid_number integer)`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id),PRIMARY KEY(user_id,group_id))`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.group_groups_v2(parent_group_id uuid REFERENCES auth.groups(id),child_group_id uuid REFERENCES auth.groups(id),PRIMARY KEY(parent_group_id,child_group_id))`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups(user_id uuid REFERENCES auth.users(id),group_name text)`.simple();
    await db`CREATE TABLE IF NOT EXISTS settings.entries(key text PRIMARY KEY,value text NOT NULL)`.simple();
    service = createAccountIdentityService(db);
  });
  beforeEach(async () => {
    await db`TRUNCATE auth.users,auth.groups,auth.user_posix,auth.user_groups_v2,auth.group_groups_v2,auth.ipa_user_effective_groups,settings.entries CASCADE`.simple();
    await setting("linux.identity_config", JSON.stringify(config));
    await setting("freeipa.enable", true);
  });
  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });

  test("reads only caller and exposes actual UID and primary GID without assuming equality", async () => {
    const actor = await user("alice", "ipa");
    await user("other");
    await db`INSERT INTO auth.user_posix VALUES(${actor.user.id}::uuid,'ipa',10001,10007)`;
    expect(await service.self(actor)).toEqual({
      user: {
        id: actor.user.id,
        username: "alice",
        provider: "ipa",
        profile: "user",
        posix: { uidNumber: 10001, primaryGidNumber: 10007 },
      },
      availability: { localLinuxEnabled: true, freeipaEnabled: true },
    });
    await db`UPDATE auth.user_posix SET managed_by='local'`;
    expect((await service.self(actor)).user.posix).toBeNull();
    await db`UPDATE auth.user_posix SET managed_by='ipa',primary_gid_number=NULL`;
    expect((await service.self(actor)).user.posix).toBeNull();
  });
  test("fresh database expiry, category, provider and username revoke a stale actor", async () => {
    const actor = await user("alice");
    await db`UPDATE auth.users SET account_expires=now()-interval '1 second'`;
    await expect(service.self(actor)).rejects.toMatchObject({ code: "identity_unavailable" });
    await db`UPDATE auth.users SET account_expires=NULL`;
    await setting("user.category.login.enabled", false);
    await expect(service.groups(actor)).rejects.toMatchObject({ code: "identity_unavailable" });
    await setting("user.category.login.enabled", true);
    await db`UPDATE auth.users SET provider='ipa'`;
    await expect(service.self(actor)).rejects.toMatchObject({ code: "identity_unavailable" });
    await db`UPDATE auth.users SET provider='local',uid='renamed'`;
    await expect(service.self(actor)).rejects.toMatchObject({ code: "identity_unavailable" });
    await db`DELETE FROM auth.users`;
    await expect(service.self(actor)).rejects.toMatchObject({ code: "identity_unavailable" });
  });
  test("user-bound credentials read their delegate while resource-bound credentials have no personal inventory", async () => {
    const actor = await user("delegate");
    const credential: RequestActor = {
      kind: "service_account",
      serviceAccount: {
        id: crypto.randomUUID(),
        name: "test",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: actor.user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: actor.user.id,
        createdAt: new Date().toISOString(),
      },
      delegatedUser: actor.user,
      scopes: [],
    };
    expect((await service.self(credential)).user.id).toBe(actor.user.id);
    await expect(service.self({ ...credential, delegatedUser: null })).rejects.toMatchObject({ code: "user_required", status: 401 });
  });
  test("provider switches are independent, durable and reject malformed configuration", async () => {
    const local = await user("local");
    const ipa = await user("ipa", "ipa");
    await setting("linux.identity_config", JSON.stringify({ ...config, enabled: false }));
    expect((await service.self(ipa)).availability).toEqual({ localLinuxEnabled: false, freeipaEnabled: true });
    await setting("freeipa.enable", false);
    await expect(service.self(ipa)).rejects.toMatchObject({ code: "identity_unavailable" });
    expect((await service.self(local)).availability.freeipaEnabled).toBe(false);
    await setting("freeipa.enable", "false");
    await expect(service.self(local)).rejects.toMatchObject({ code: "invalid_identity_configuration" });
  });
  test("effective groups include nested local memberships for an IPA user and exclude unrelated groups", async () => {
    const actor = await user("ipa", "ipa");
    const direct = await group("child");
    const parent = await group("parent", "local", 200005);
    const external = await group("ipa-member", "ipa", 100005);
    const crossProvider = await group("invalid-parent", "ipa", 100006);
    await group("unrelated", "local", 200006);
    await db`INSERT INTO auth.user_groups_v2 VALUES(${actor.user.id}::uuid,${direct}::uuid),(${actor.user.id}::uuid,${external}::uuid)`;
    await db`INSERT INTO auth.group_groups_v2 VALUES(${parent}::uuid,${direct}::uuid),(${direct}::uuid,${parent}::uuid),(${crossProvider}::uuid,${direct}::uuid)`;
    expect((await service.groups(actor)).items.map((item) => item.id).sort()).toEqual([direct, parent, external].sort());
    await db`DELETE FROM auth.user_groups_v2 WHERE group_id=${direct}::uuid`;
    expect((await service.groups(actor)).items.map((item) => item.id)).toEqual([external]);
  });
  test("effective groups flag the personal Linux group stored as a user's primary group", async () => {
    const actor = await user("owner");
    const personal = await group("owner", "local", 200007);
    const team = await group("team", "local", 200008);
    await db`INSERT INTO auth.user_groups_v2 VALUES(${actor.user.id}::uuid,${personal}::uuid),(${actor.user.id}::uuid,${team}::uuid)`;
    await db`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id) VALUES(${actor.user.id}::uuid,'local',200007,200007,${personal}::uuid)`;
    const items = (await service.groups(actor)).items;
    expect(items.find((item) => item.id === personal)).toMatchObject({ name: "owner", personal: true });
    expect(items.find((item) => item.id === team)).toMatchObject({ name: "team", personal: false });
  });
  test("groups and inventories paginate without omitting records beyond fifty", async () => {
    const actor = await user("admin", "local", true);
    await db`INSERT INTO auth.groups(name,provider,gid_number) SELECT 'group-'||n,'local',200000+n FROM generate_series(1,53) n`;
    await db`INSERT INTO auth.user_groups_v2 SELECT ${actor.user.id}::uuid,id FROM auth.groups`;
    const first = await service.groups(actor);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.groups(actor, { after: first.nextCursor! });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(53);
    const inventory = await service.inventory(actor, { kind: "groups", provider: "local" });
    expect(inventory).toEqual(first);
    await expect(service.groups(actor, { after: "invalid" })).rejects.toMatchObject({ status: 400 });
  });
  test("inventory is admin-only, provider scoped, and rechecks removed admin rights", async () => {
    const actor = await user("admin", "local", true);
    await user("ipa", "ipa");
    expect((await service.inventory(actor, { kind: "users", provider: "local" })).items.map((item) => item.id)).toEqual([actor.user.id]);
    await db`UPDATE auth.users SET admin=false WHERE id=${actor.user.id}::uuid`;
    await expect(service.inventory(actor, { kind: "users", provider: "ipa" })).rejects.toMatchObject({ code: "admin_required" });
  });
  test("exact inventory filters match canonical names and stable IDs without scanning all pages", async () => {
    const actor = await user("admin", "local", true);
    const alice = await user("alice");
    await user("alice2");
    const localGroup = await group("shared", "local", 200003);
    await group("shared", "ipa", 100003);
    expect((await service.inventory(actor, { kind: "users", provider: "local", name: "alice" })).items.map((item) => item.id)).toEqual([
      alice.user.id,
    ]);
    expect((await service.inventory(actor, { kind: "groups", provider: "local", name: "shared" })).items.map((item) => item.id)).toEqual([
      localGroup,
    ]);
    expect((await service.inventory(actor, { kind: "groups", provider: "ipa", id: localGroup })).items).toEqual([]);
    expect((await service.inventory(actor, { kind: "users", provider: "local", id: alice.user.id, name: "wrong" })).items).toEqual([]);
  });
  test("IPA administrator rights follow current effective membership and durable admin group settings", async () => {
    const actor = await user("ipa", "ipa", true);
    await expect(service.inventory(actor, { kind: "groups", provider: "ipa" })).rejects.toMatchObject({ code: "admin_required" });
    await db`INSERT INTO auth.ipa_user_effective_groups VALUES(${actor.user.id}::uuid,'admins')`;
    expect((await service.inventory(actor, { kind: "groups", provider: "ipa" })).items).toEqual([]);
    await setting("freeipa.groups.admin", ["different-admins"]);
    await expect(service.inventory(actor, { kind: "groups", provider: "ipa" })).rejects.toMatchObject({ code: "admin_required" });
  });
  test("reconciliation requires current admin authority and bypasses the Cloud mirror for IPA", async () => {
    let calls = 0;
    const authoritative = createAccountIdentityService(db, async ({ name }) => {
      calls++;
      return { state: "present", identity: { id: null, name, uidNumber: 20001, gidNumber: 20002 }, eligible: true };
    });
    const admin = await user("admin", "local", true);
    const member = await user("member");
    await expect(authoritative.reconcile(member, { kind: "users", provider: "ipa", name: "outside-sync" })).rejects.toMatchObject({
      code: "admin_required",
    });
    expect(calls).toBe(0);
    expect(await authoritative.reconcile(admin, { kind: "users", provider: "ipa", name: "outside-sync" })).toMatchObject({
      state: "present",
      identity: { id: null, name: "outside-sync" },
    });
    expect(calls).toBe(1);
    await setting("freeipa.enable", false);
    expect(await authoritative.reconcile(admin, { kind: "users", provider: "ipa", name: "outside-sync" })).toEqual({
      state: "unknown",
      reason: "provider_disabled",
    });
    expect(calls).toBe(1);
  });
  test("local lifecycle keeps expired and disabled-category users present; global disable does not imply absence", async () => {
    const actor = await user("retained");
    const input = { kind: "users" as const, identityId: actor.user.id, name: "retained" };
    await db`UPDATE auth.users SET account_expires=now()-interval '1 day'`;
    await setting("user.category.login.enabled", false);
    expect(await service.localLifecycle(input)).toMatchObject({
      localLinuxEnabled: true,
      identity: { state: "present", eligible: true, identity: { id: actor.user.id } },
    });
    await setting("linux.identity_config", JSON.stringify({ ...config, enabled: false }));
    expect(await service.localLifecycle(input)).toMatchObject({ localLinuxEnabled: false, identity: { state: "present", eligible: true } });
  });
  test("local lifecycle differentiates rename/provider changes, deleted ID, name reuse, and non-POSIX groups", async () => {
    const actor = await user("original");
    const input = { kind: "users" as const, identityId: actor.user.id, name: "original" };
    await db`UPDATE auth.users SET uid='renamed' WHERE id=${actor.user.id}::uuid`;
    expect((await service.localLifecycle(input)).identity).toEqual({ state: "unknown", reason: "identity_conflict" });
    await db`UPDATE auth.users SET uid='original',provider='ipa' WHERE id=${actor.user.id}::uuid`;
    expect((await service.localLifecycle(input)).identity).toEqual({ state: "unknown", reason: "identity_conflict" });
    await db`DELETE FROM auth.users WHERE id=${actor.user.id}::uuid`;
    expect((await service.localLifecycle(input)).identity).toEqual({ state: "absent" });
    const reused = await user("original");
    expect((await service.localLifecycle(input)).identity).toMatchObject({ state: "present", identity: { id: reused.user.id } });
    const id = await group("logical", "local", 200003);
    expect((await service.localLifecycle({ kind: "groups", identityId: id, name: "logical" })).identity).toMatchObject({
      state: "present",
      eligible: true,
    });
    await db`UPDATE auth.groups SET gid_number=NULL WHERE id=${id}::uuid`;
    expect((await service.localLifecycle({ kind: "groups", identityId: id, name: "logical" })).identity).toMatchObject({
      state: "present",
      eligible: false,
      identity: { id, gidNumber: null },
    });
  });
});
