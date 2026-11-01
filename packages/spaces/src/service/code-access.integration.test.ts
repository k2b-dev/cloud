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
    expect(await spaceCodeAccess.manages(ownerContext, target.short_id)).toBe(true);
    expect(await spaceCodeAccess.manages(code, target.short_id)).toBe(false);
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
    await expect(sql`INSERT INTO auth.access (service_account_id, permission)
      VALUES (${principal(code)}::uuid, 'admin')`).rejects.toMatchObject({ code: "23514" });
    expect(await permission(target.id)).toBe("none");
    const write = await grant(target.short_id, code, ["spaces.task.create"]);
    expect(write.decision).toEqual({ granted: true, level: "write" });
    await expect(sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${write.grantId}::uuid`).rejects.toMatchObject({
      code: "23514",
    });
    expect(await permission(target.id)).toBe("write");
    expect(await spaceCodeAccess.manages(code, target.short_id)).toBe(false);
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
});
