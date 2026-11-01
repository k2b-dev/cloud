import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { serviceAccounts } from "@k2b/cloud/services";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { spacesCapabilities } from "../capabilities";
import { AccessEntrySchema } from "../contracts";
import {
  getActorsSpacePermissions,
  getResourceSpacePermissions,
  getSpacePermission,
  grantSpaceAccess,
  listSpaceAccess,
  readableSpacePrincipals,
  revokeSpaceAccess,
  updateSpaceAccessPermission,
} from "./access";
import { spaceCodeAccess } from "./code-access";
import { list, listPage } from "./spaces";

const suite = suiteFor("database", "nats");

suite("Spaces Code access", () => {
  const suffix = crypto.randomUUID();
  const spaceIds: string[] = [];
  const accountIds: string[] = [];
  let owner: User;
  let ownerContext: CapabilityExecutionContext;
  let code: CapabilityExecutionContext;
  let otherCode: CapabilityExecutionContext;
  let ordinary: CapabilityExecutionContext;
  let groupId: string;

  const createAccount = async (kind: "code" | "standalone", name: string): Promise<CapabilityExecutionContext> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`c3b-${name}-${suffix}`}, ${kind}) RETURNING id`;
    if (!row) throw new Error("Missing account");
    accountIds.push(row.id);
    const account = await serviceAccounts.get({ id: row.id });
    if (!account) throw new Error("Missing account");
    return {
      // C2 projects a read/write compatibility ceiling for a verified Code mandate.
      actor: { kind: "service_account", serviceAccount: account, delegatedUser: null, scopes: ["read", "write"] },
      accessSubject: { type: "service_account", serviceAccountId: account.id },
      requestId: "c3b-access",
      user: null,
      origin: "app",
      locale: "en",
      signal: new AbortController().signal,
    };
  };
  const principal = (context: CapabilityExecutionContext) => {
    if (context.accessSubject.type !== "service_account") throw new Error("Expected service account");
    return context.accessSubject.serviceAccountId;
  };
  const space = async () => {
    const [row] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
      VALUES (${testShortId()}, 'Code target') RETURNING id, short_id`;
    if (!row) throw new Error("Missing Space");
    spaceIds.push(row.id);
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      VALUES (${owner.id}::uuid, 'admin') RETURNING id`;
    if (!access) throw new Error("Missing owner grant");
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${row.id}::uuid, ${access.id}::uuid)`;
    const [column] = await sql<{ short_id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
      VALUES (${testShortId()}, ${row.id}::uuid, 'Open', 1024) RETURNING short_id`;
    if (!column) throw new Error("Missing column");
    return { ...row, ownerGrantId: access.id, columnId: column.short_id };
  };
  const grant = (
    id: string,
    context: CapabilityExecutionContext,
    operations: string[],
    grantId: string = crypto.randomUUID(),
    dryRun = false,
  ) =>
    sql.begin(async (tx) => ({
      decision: await spaceCodeAccess.grant(tx, { id, principal: principal(context), operations, grantId, dryRun }),
      grantId,
    }));
  const grants = (context: CapabilityExecutionContext) => sql.begin((tx) => spaceCodeAccess.list(tx, { principal: principal(context) }));
  const revoke = (id: string, grantId: string) => sql.begin((tx) => spaceCodeAccess.revoke(tx, { id, grantId }));
  const permission = (id: string, context = code) => getSpacePermission({ spaceId: id, subject: context.accessSubject });

  const manages = (context: CapabilityExecutionContext, id: string) => sql.begin((tx) => spaceCodeAccess.manages(tx, context, id));

  beforeAll(async () => {
    const uid = `c3b-owner-${suffix}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${uid}, 'local', 'user', 'Space owner') RETURNING id`;
    if (!row) throw new Error("Missing owner");
    owner = {
      id: row.id,
      uid,
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: "Space",
      sn: "Owner",
      displayName: "Space owner",
      mail: "owner@example.test",
      avatarHash: null,
      ipa: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      accountExpires: null,
      lastLoginLocal: null,
    };
    ownerContext = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId: owner.id },
      user: owner,
      requestId: "c3b-access",
      origin: "app",
      locale: "en",
      signal: new AbortController().signal,
    };
    code = await createAccount("code", "first");
    otherCode = await createAccount("code", "second");
    ordinary = await createAccount("standalone", "ordinary");
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`c3b-${suffix}`}, 'local', 'Code group') RETURNING id`;
    if (!group) throw new Error("Missing group");
    groupId = group.id;
    await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id)
      VALUES (${principal(code)}::uuid, ${groupId}::uuid), (${principal(ordinary)}::uuid, ${groupId}::uuid)`;
  });

  afterAll(async () => {
    for (const id of spaceIds) {
      const accesses = await sql<{ access_id: string }[]>`SELECT access_id FROM spaces.space_access WHERE space_id = ${id}::uuid`;
      await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
      for (const access of accesses) await sql`DELETE FROM auth.access WHERE id = ${access.access_id}::uuid`;
    }
    for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("sets independent grants and removes their access immediately at the capability, single and batched seams", async () => {
    const target = await space();
    expect(await manages(ownerContext, target.short_id)).toBe(true);
    expect(await manages(code, target.short_id)).toBe(false);
    const read = await grant(target.short_id, code, ["spaces.space.read"]);
    const write = await grant(target.short_id, code, ["spaces.task.create"]);
    expect(read.decision).toEqual({ granted: true, level: "read" });
    expect(write.decision).toEqual({ granted: true, level: "write" });
    expect((await grant(target.short_id, code, ["spaces.task.create"], write.grantId)).decision).toEqual(write.decision);
    expect(await permission(target.id)).toBe("write");
    expect(
      (
        await spacesCapabilities.actions["task.create"].run(
          spacesCapabilities.actions["task.create"].input.parse({ title: "Allowed", columnId: target.columnId }),
          { ...code, target: { type: "spaces.space", id: target.short_id } },
        )
      ).ok,
    ).toBe(true);
    expect((await spacesCapabilities.queries["space.read"].run({ id: target.short_id }, code)).ok).toBe(true);
    expect((await grants(code)).filter((entry) => entry.id === target.short_id)).toHaveLength(2);
    const shares = await listSpaceAccess(target.id);
    expect(AccessEntrySchema.parse(shares.find((entry) => entry.id === write.grantId)).grantId).toBe(write.grantId);
    expect(shares.find((entry) => entry.id === target.ownerGrantId)?.grantId).toBeUndefined();
    for (const mutation of [
      revokeSpaceAccess({
        spaceId: target.id,
        accessId: write.grantId,
        caller: { actor: ownerContext.actor, accessSubject: ownerContext.accessSubject },
      }),
      updateSpaceAccessPermission({
        spaceId: target.id,
        accessId: write.grantId,
        permission: "admin",
        caller: { actor: ownerContext.actor, accessSubject: ownerContext.accessSubject },
      }),
    ]) {
      const result = await mutation;
      expect(result).toMatchObject({ ok: false, error: { status: 400 } });
      if (!result.ok) expect(result.error.message).toContain("grantId");
    }
    expect(await revoke(target.short_id, write.grantId)).toBe(true);
    expect(await permission(target.id)).toBe("read");
    expect(
      await getActorsSpacePermissions(target.id, [
        { actor: code.actor, subject: code.accessSubject },
        { actor: ownerContext.actor, subject: ownerContext.accessSubject },
      ]),
    ).toEqual(["read", "admin"]);
    const refused = await spacesCapabilities.actions["task.create"].run(
      spacesCapabilities.actions["task.create"].input.parse({ title: "Denied", columnId: target.columnId }),
      { ...code, target: { type: "spaces.space", id: target.short_id } },
    );
    expect(refused.ok).toBe(false);
    expect(await revoke(target.short_id, read.grantId)).toBe(true);
    expect(await permission(target.id)).toBe("none");
    expect((await spacesCapabilities.queries["space.read"].run({ id: target.short_id }, code)).ok).toBe(false);
    expect(
      await getResourceSpacePermissions(target.id, [
        { principal: { type: "service_account", serviceAccountId: principal(code) }, subject: code.accessSubject, binding: null },
      ]),
    ).toEqual(["none"]);
    expect(await revoke(target.short_id, read.grantId)).toBe(false);
    expect(await permission(target.id, ownerContext)).toBe("admin");
  });

  test("dry runs and refusals write nothing, and grant identities never replace or remove another target or ordinary share", async () => {
    const target = await space();
    const elsewhere = await space();
    expect((await grant(target.short_id, code, ["spaces.task.create"], crypto.randomUUID(), true)).decision.granted).toBe(true);
    expect((await grant(target.short_id, code, [], crypto.randomUUID(), true)).decision.granted).toBe(true);
    for (const operations of [
      ["spaces.task.create", "spaces.template.create"],
      ["spaces.event.invitation.commit"],
      ["mail.draft.create"],
      [],
    ])
      expect((await grant(target.short_id, code, operations)).decision.granted).toBe(false);
    expect((await grant(target.short_id, ordinary, ["spaces.space.read"])).decision.granted).toBe(false);
    expect((await grants(code)).some((entry) => entry.id === target.short_id)).toBe(false);
    expect(await permission(target.id)).toBe("none");
    const read = await grant(target.short_id, code, ["spaces.space.read"]);
    expect((await grant(target.short_id, otherCode, ["spaces.space.read"], read.grantId)).decision.granted).toBe(false);
    expect((await grant(target.short_id, code, ["spaces.task.create"], read.grantId)).decision.granted).toBe(false);
    expect((await grant(target.short_id, code, ["spaces.space.read"], target.ownerGrantId)).decision.granted).toBe(false);
    expect(await revoke(elsewhere.short_id, read.grantId)).toBe(false);
    expect(await revoke(target.short_id, target.ownerGrantId)).toBe(false);
    expect(await permission(target.id, ownerContext)).toBe("admin");
    expect((await grant("missing", code, ["spaces.space.read"])).decision.granted).toBe(false);
  });

  test("Code ignores all-signed-in, group and public access on another Space across readers and discovery; people keep their access", async () => {
    const target = await space();
    const elsewhere = await space();
    const own = await grant(target.short_id, code, ["spaces.space.read"]);
    await grant(elsewhere.short_id, otherCode, ["spaces.task.create"]);
    const inherited = await sql<{ id: string }[]>`INSERT INTO auth.access (group_id, authenticated_only, permission)
      VALUES (${groupId}::uuid, false, 'write'), (NULL, true, 'write'), (NULL, false, 'write') RETURNING id`;
    for (const access of inherited)
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${elsewhere.id}::uuid, ${access.id}::uuid)`;
    expect((await grants(code)).filter((entry) => [target.short_id, elsewhere.short_id].includes(entry.id))).toEqual([
      { grantId: own.grantId, id: target.short_id, level: "read" },
    ]);
    expect(await grants(ordinary)).toEqual([]);
    expect(await permission(elsewhere.id)).toBe("none");
    expect(await permission(elsewhere.id, ordinary)).toBe("write");
    expect(await permission(elsewhere.id, ownerContext)).toBe("admin");
    expect((await spacesCapabilities.queries["space.read"].run({ id: elsewhere.short_id }, code)).ok).toBe(false);
    expect((await list({ subject: code.accessSubject })).some((entry) => entry.id === elsewhere.id)).toBe(false);
    expect((await listPage({ subject: code.accessSubject })).items.some((entry) => entry.id === elsewhere.id)).toBe(false);
    expect((await list({ subject: ordinary.accessSubject })).some((entry) => entry.id === elsewhere.id)).toBe(true);
    expect(
      await readableSpacePrincipals(elsewhere.id, [
        { type: "service_account", serviceAccountId: principal(code) },
        { type: "service_account", serviceAccountId: principal(ordinary) },
      ]),
    ).toEqual([{ type: "service_account", serviceAccountId: principal(ordinary) }]);
    expect(await getActorsSpacePermissions(elsewhere.id, [{ actor: code.actor, subject: code.accessSubject }])).toEqual(["none"]);
  });

  test("Code never gains admin or counts as the last manager", async () => {
    const target = await space();
    await expect(
      sql`INSERT INTO auth.access (service_account_id, permission)
      VALUES (${principal(code)}::uuid, 'admin')`.execute(),
    ).rejects.toMatchObject({ errno: "23514" });
    expect(await permission(target.id)).toBe("none");
    const write = await grant(target.short_id, code, ["spaces.task.create"]);
    expect(write.decision).toEqual({ granted: true, level: "write" });
    await expect(sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${write.grantId}::uuid`.execute()).rejects.toMatchObject({
      errno: "23514",
    });
    expect(await permission(target.id)).toBe("write");
    expect(await manages(code, target.short_id)).toBe(false);
    expect((await list({ subject: code.accessSubject, requiredLevel: "admin" })).some((entry) => entry.id === target.id)).toBe(false);
    expect(await getActorsSpacePermissions(target.id, [{ actor: code.actor, subject: code.accessSubject }])).toEqual(["write"]);
    expect(
      await getResourceSpacePermissions(target.id, [
        { principal: { type: "service_account", serviceAccountId: principal(code) }, subject: code.accessSubject, binding: null },
      ]),
    ).toEqual(["write"]);
    for (const mutation of [
      updateSpaceAccessPermission({
        spaceId: target.id,
        accessId: target.ownerGrantId,
        permission: "write",
        caller: { actor: ownerContext.actor, accessSubject: ownerContext.accessSubject },
      }),
      revokeSpaceAccess({
        spaceId: target.id,
        accessId: target.ownerGrantId,
        caller: { actor: ownerContext.actor, accessSubject: ownerContext.accessSubject },
      }),
    ])
      expect(await mutation).toMatchObject({ ok: false, error: { code: "LAST_MANAGER" } });
    expect(
      (
        await grantSpaceAccess({
          spaceId: target.id,
          principal: { type: "service_account", serviceAccountId: principal(code) },
          permission: "admin",
          caller: { actor: ownerContext.actor, accessSubject: ownerContext.accessSubject },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await grantSpaceAccess({
          spaceId: target.id,
          principal: { type: "authenticated" },
          permission: "read",
          caller: { actor: code.actor, accessSubject: code.accessSubject },
        })
      ).ok,
    ).toBe(false);
  });
  test("dry-run reports current direct and nested-group person managers without granting access", async () => {
    const target = await space();
    const [person] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES (${`spaces-manager-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
    const [child] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`spaces-child-${crypto.randomUUID()}`}, 'local', 'Nested managers') RETURNING id`;
    if (!person || !child) throw new Error("Missing manager fixture");
    try {
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${person.id}::uuid, ${child.id}::uuid),
        (${owner.id}::uuid, ${child.id}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${groupId}::uuid, ${child.id}::uuid)`;
      const [share] = await sql<{ id: string }[]>`INSERT INTO auth.access (group_id, permission)
        VALUES (${groupId}::uuid, 'admin') RETURNING id`;
      if (!share) throw new Error("Missing manager share");
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${target.id}::uuid, ${share.id}::uuid)`;
      const result = await grant(target.short_id, code, ["spaces.space.read"], crypto.randomUUID(), true);
      expect(result.decision).toEqual({ granted: true, level: "read", managerUserIds: [owner.id, person.id].sort() });
      expect(await sql`SELECT id FROM auth.access WHERE id = ${result.grantId}::uuid`).toHaveLength(0);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${person.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${child.id}::uuid`;
    }
  });

  test("a manager removed after a preflight check cannot grant from stale authority", async () => {
    const target = await space();
    const current = ownerContext;
    expect(await manages(current, target.short_id)).toBe(true);
    const changed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checking = Promise.withResolvers<number>();
    const change = sql.begin(async (tx) => {
      await tx`SELECT id FROM spaces.spaces WHERE id = ${target.id}::uuid FOR UPDATE`;
      await tx`UPDATE auth.access SET permission = 'read' WHERE id IN (
        SELECT access_id FROM spaces.space_access WHERE space_id = ${target.id}::uuid
      ) AND user_id = ${owner.id}::uuid`;
      changed.resolve();
      await release.promise;
    });
    let pending: Promise<boolean> | undefined;
    try {
      await Promise.race([
        changed.promise,
        change.then(() => {
          throw new Error("Manager change skipped checkpoint");
        }),
      ]);
      pending = sql.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error("Missing backend PID");
        checking.resolve(backend.pid);
        if (!(await spaceCodeAccess.manages(tx, current, target.short_id))) return false;
        return (
          await spaceCodeAccess.grant(tx, {
            id: target.short_id,
            principal: principal(code),
            operations: ["spaces.space.read"],
            grantId: crypto.randomUUID(),
            dryRun: false,
          })
        ).granted;
      });
      const pid = await Promise.race([
        checking.promise,
        pending.then(() => {
          throw new Error("Code check ended before lock acquisition");
        }),
      ]);
      // Observe this transaction blocked on the mutation's target lock before
      // committing it; a check without a lock must fail this regression guard.
      const deadline = AbortSignal.timeout(2000);
      let blocked = false;
      while (!deadline.aborted) {
        const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
        ) AS blocked`;
        if (state?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      release.resolve();
      await change;
      expect(await pending).toBe(false);
      expect((await grants(code)).some((entry) => entry.id === target.short_id)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([change, ...(pending ? [pending] : [])]);
    }
  });

  test("manager authority stays locked through the adapter write", async () => {
    const target = await space();
    await sql.begin(async (tx) => {
      expect(await spaceCodeAccess.manages(tx, ownerContext, target.short_id)).toBe(true);
      expect(
        (
          await spaceCodeAccess.grant(tx, {
            id: target.short_id,
            principal: principal(code),
            operations: ["spaces.space.read"],
            grantId: crypto.randomUUID(),
            dryRun: false,
          })
        ).granted,
      ).toBe(true);
      await expect(
        sql.begin(async (other) => {
          await other`SELECT id FROM spaces.spaces WHERE id = ${target.id}::uuid FOR UPDATE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
      await expect(
        sql.begin(async (other) => {
          await other`SELECT a.id FROM auth.access a JOIN spaces.space_access grants ON grants.access_id = a.id
          WHERE grants.space_id = ${target.id}::uuid AND a.user_id = ${owner.id}::uuid FOR UPDATE OF a NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
      await expect(
        sql.begin(async (other) => {
          await other`SELECT id FROM auth.users WHERE id = ${owner.id}::uuid FOR UPDATE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
      await expect(
        sql.begin(async (other) => {
          await other`LOCK TABLE auth.groups IN ROW EXCLUSIVE MODE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
      await expect(
        sql.begin(async (other) => {
          await other`LOCK TABLE auth.user_groups_v2 IN ROW EXCLUSIVE MODE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
      await expect(
        sql.begin(async (other) => {
          await other`LOCK TABLE auth.group_groups_v2 IN ROW EXCLUSIVE MODE NOWAIT`;
        }),
      ).rejects.toThrow(/could not obtain lock/);
    });
  });
  test("manager checks use live group membership instead of the person's cached groups", async () => {
    const target = await space();
    const [share] = await sql<{ id: string }[]>`INSERT INTO auth.access (group_id, permission)
      VALUES (${groupId}::uuid, 'admin') RETURNING id`;
    if (!share) throw new Error("Missing group manager share");
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${target.id}::uuid, ${share.id}::uuid)`;
    await sql`UPDATE auth.access SET permission = 'read' WHERE id IN (
      SELECT access_id FROM spaces.space_access WHERE space_id = ${target.id}::uuid
    ) AND user_id = ${owner.id}::uuid`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${owner.id}::uuid, ${groupId}::uuid)`;
    const current = ownerContext;
    const stale = { ...current, actor: { kind: "user" as const, user: { ...owner, memberofGroupIds: [groupId] } } };
    try {
      expect(await manages(current, target.short_id)).toBe(true);
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${owner.id}::uuid AND group_id = ${groupId}::uuid`;
      expect(await manages(stale, target.short_id)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${owner.id}::uuid AND group_id = ${groupId}::uuid`;
    }
  });
  test("grant and revoke lock the existing target even when manages is bypassed", async () => {
    const target = await space();
    const grantId = crypto.randomUUID();
    for (const operation of ["grant", "revoke"] as const) {
      await sql.begin(async (tx) => {
        if (operation === "grant") {
          expect(
            (
              await spaceCodeAccess.grant(tx, {
                id: target.short_id,
                principal: principal(code),
                operations: ["spaces.space.read"],
                grantId,
                dryRun: false,
              })
            ).granted,
          ).toBe(true);
        } else {
          expect(await spaceCodeAccess.revoke(tx, { id: target.short_id, grantId })).toBe(true);
        }
        await expect(
          sql.begin(async (other) => {
            await other`SELECT id FROM spaces.spaces WHERE id = ${target.id}::uuid FOR UPDATE NOWAIT`;
          }),
        ).rejects.toThrow(/could not obtain lock/);
      });
    }
  });
  test("directory writes do not deadlock Code checks or the Cloud-admin bypass", async () => {
    const target = await space();
    await sql.begin(async (writer) => {
      await writer`LOCK TABLE auth.groups, auth.user_groups_v2, auth.group_groups_v2 IN ROW EXCLUSIVE MODE`;
      await expect(sql.begin((tx) => spaceCodeAccess.manages(tx, ownerContext, target.short_id))).rejects.toMatchObject({ errno: "55P03" });
      // Admin authority is checked by the platform, so the adapter only needs
      // its target lock and a single-snapshot manager list during preflight.
      const grantId = crypto.randomUUID();
      const decision = await sql.begin((tx) =>
        spaceCodeAccess.grant(tx, {
          id: target.short_id,
          principal: principal(code),
          operations: ["spaces.space.read"],
          grantId,
          dryRun: true,
        }),
      );
      expect(decision).toEqual({ granted: true, level: "read", managerUserIds: [owner.id] });
      expect((await grant(target.short_id, code, ["spaces.space.read"], grantId)).decision.granted).toBe(true);
      expect(await revoke(target.short_id, grantId)).toBe(true);
      await writer`SELECT 1`;
    });
  });
});
