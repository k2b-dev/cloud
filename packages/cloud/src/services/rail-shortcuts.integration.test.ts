import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, requireDatabaseUrl } from "../../../../scripts/fixtures/test-infra";
import { type RailAdminEntry, RailAdminSchema } from "../contracts/rail-admin";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { createRailPreferencesService } from "./rail-preferences";
import { createRailShortcutsService, RailAdminError } from "./rail-shortcuts";
import { createRailSnapshotReader } from "./rail-snapshot";
import { buildProjectedUser, loadCurrentUser } from "./session/user";

const suite = databaseSuite();
suite("managed rail persistence and transactional invalidation", () => {
  let db: SQL;
  let service: ReturnType<typeof createRailShortcutsService>;
  let personal: ReturnType<typeof createRailPreferencesService>;
  const admin = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
  const target = crypto.randomUUID();
  const other = crypto.randomUUID();
  const parent = crypto.randomUUID();
  const child = crypto.randomUUID();
  const entry = (id: string, principal?: RailAdminEntry["access"][number]["principal"]): RailAdminEntry => ({
    shortcut: { id, kind: "link", title: id, href: `/${id}`, icon: "ti ti-link" },
    access: principal ? [{ id: crypto.randomUUID(), principal, permission: "read", createdAt: new Date().toISOString() }] : [],
  });
  beforeAll(async () => {
    db = new SQL(requireDatabaseUrl());
    await (await import("../../../core/src/migrate/core/auth")).migrate();
    await (await import("../../../core/src/migrate/core/rail-preferences")).migrate(db);
    const { migrate } = await import("../../../core/src/migrate/core/rail-shortcuts");
    await migrate(db);
    await migrate(db);
    service = createRailShortcutsService(db);
    personal = createRailPreferencesService(db);
    await db`INSERT INTO auth.users(id, uid, provider, profile, display_name) VALUES
      (${target}::uuid, ${target}, 'local', 'user', 'Target'), (${other}::uuid, ${other}, 'local', 'user', 'Other')`;
    await db`INSERT INTO auth.groups(id, cn, provider, name) VALUES
      (${parent}::uuid, ${parent}, 'local', ${`Parent ${parent}`}), (${child}::uuid, ${child}, 'local', ${`Child ${child}`})`;
    await db`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES (${target}::uuid, ${child}::uuid)`;
    await db`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
  });
  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM auth.users WHERE id IN (${target}::uuid, ${other}::uuid)`;
    await db`DELETE FROM auth.groups WHERE id IN (${parent}::uuid, ${child}::uuid)`;
    await db.close();
  });
  test("service guards, canonical audiences, ordering, conflicts and transactional failure", async () => {
    await expect(service.list(undefined)).rejects.toBeInstanceOf(RailAdminError);
    const initial = await service.list(admin);
    const saved = await service.save(admin, {
      ...initial,
      entries: [
        entry("all", { type: "authenticated" }),
        entry("group", { type: "group", groupId: parent }),
        entry("direct", { type: "user", userId: other }),
        entry("draft"),
      ],
    });
    expect((await service.forUser(target)).map((item) => item.id)).toEqual(["all", "group"]);
    expect((await service.forUser(other)).map((item) => item.id)).toEqual(["all", "direct"]);
    expect(saved.entries[1]?.access[0]?.displayName).toBe(`Parent ${parent}`);
    await expect(service.save(admin, initial)).rejects.toMatchObject({ status: 409 });
    await expect(
      service.save(admin, { ...saved, entries: [entry("invalid", { type: "user", userId: crypto.randomUUID() })] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await service.list(admin)).toEqual(saved);
    expect(
      RailAdminSchema.safeParse({
        ...saved,
        entries: [
          entry("invalid", { type: "authenticated" }),
          { ...entry("other"), access: [{ id: crypto.randomUUID(), principal: { type: "public" }, permission: "read", createdAt: "" }] },
        ],
      }).success,
    ).toBe(false);
  });
  test("identity query versions invalidate warm cache on personal, nested membership and ACL changes", async () => {
    let loads = 0;
    const values = new Map<string, string>();
    const read = createRailSnapshotReader(
      async (id) => {
        loads++;
        return { ...(await personal.get(id)), managedShortcuts: await service.forUser(id) };
      },
      {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value);
        },
      },
    );
    const current = async () => {
      const user = await loadCurrentUser({ userId: target, groupsAdmin: [] }, db);
      if (!user) throw new Error("Missing test user");
      return read(user);
    };
    expect((await current()).managedShortcuts?.map((item) => item.id)).toEqual(["all", "group"]);
    await current();
    expect(loads).toBe(1);
    await personal.save(target, { ...defaultRailPreferences(), visibility: { mail: false } });
    expect((await current()).visibility).toEqual({ mail: false });
    expect(loads).toBe(2);
    await db`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${parent}::uuid`;
    expect((await current()).managedShortcuts?.map((item) => item.id)).toEqual(["all"]);
    expect(loads).toBe(3);
    await db`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
    expect((await current()).managedShortcuts?.map((item) => item.id)).toEqual(["all", "group"]);
    await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM auth.rail_shortcut_access WHERE shortcut_id = 'group')`;
    expect((await current()).managedShortcuts?.map((item) => item.id)).toEqual(["all"]);
    const before = loads;
    try {
      await db.begin(async (tx) => {
        await tx`DELETE FROM auth.user_groups_v2 WHERE user_id = ${target}::uuid`;
        throw new Error("rollback");
      });
    } catch {
      /* intentional */
    }
    await current();
    expect(loads).toBe(before);
    const revisionBeforeClear = (await service.list(admin)).revision;
    await service.invalidateCache(admin);
    await current();
    expect(loads).toBe(before + 1);
    await current();
    expect(loads).toBe(before + 1);
    expect((await service.list(admin)).revision).toBe(revisionBeforeClear);
    await db`DELETE FROM auth.rail_preferences WHERE user_id = ${target}::uuid`;
    expect((await current()).visibility).toEqual({});
    await personal.save(target, { ...defaultRailPreferences(), visibility: { mail: true } });
    expect((await current()).visibility).toEqual({ mail: true });
  });
  test("concurrent admins cannot overwrite each other", async () => {
    const state = await service.list(admin);
    const result = await Promise.allSettled([service.save(admin, state), service.save(admin, state)]);
    expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  });
});
