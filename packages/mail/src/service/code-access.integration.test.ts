import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { serviceAccounts } from "@k2b/cloud/services";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import {
  getMailboxAccesses,
  getMailboxPermission,
  grantMailboxAccess,
  listMailboxAccess,
  readableMailboxGrants,
  revokeMailboxAccess,
  updateMailboxAccess,
} from "./access";
import type { MailRequestContext } from "./auth";
import { mailboxCodeAccess } from "./code-access";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

suite("Mail mailbox Code access", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  const accountIds: string[] = [];
  const ordinaryAccessIds: string[] = [];
  let owner: User;
  let ownerContext: MailRequestContext;
  let code: MailRequestContext;
  let otherCode: MailRequestContext;
  let ordinary: MailRequestContext;
  let groupId: string;

  const createAccount = async (kind: "code" | "standalone", name: string): Promise<MailRequestContext> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`c3c-${name}-${suffix}`}, ${kind}) RETURNING id`;
    if (!row) throw new Error("Missing service account");
    accountIds.push(row.id);
    const account = await serviceAccounts.get({ id: row.id });
    if (!account) throw new Error("Missing service account");
    return {
      // C2 projects read/write as the non-admin ceiling for a verified Code mandate.
      actor: { kind: "service_account", serviceAccount: account, delegatedUser: null, scopes: ["read", "write"] },
      accessSubject: { type: "service_account", serviceAccountId: account.id },
    };
  };
  const principal = (context: MailRequestContext): string => {
    if (context.accessSubject.type !== "service_account") throw new Error("Expected service account");
    return context.accessSubject.serviceAccountId;
  };
  const capabilityContext = (context: MailRequestContext): CapabilityExecutionContext => ({
    ...context,
    requestId: "c3c-access",
    user: context.actor.kind === "user" ? context.actor.user : null,
    locale: "en",
    origin: "app",
    signal: new AbortController().signal,
  });
  const mailbox = async () => {
    const result = await createMailbox(ownerContext, { name: `Code mailbox ${suffix}` });
    if (!result.ok) throw new Error(result.error.message);
    mailboxIds.push(result.data.id);
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${result.data.id}::uuid`;
    if (!row) throw new Error("Missing mailbox public ID");
    return { id: result.data.id, shortId: row.short_id };
  };
  const grant = (id: string, context: MailRequestContext, operations: string[], grantId: string = crypto.randomUUID(), dryRun = false) =>
    sql.begin(async (tx) => ({
      decision: await mailboxCodeAccess.grant(tx, { id, principal: principal(context), operations, grantId, dryRun }),
      grantId,
    }));
  const list = (context: MailRequestContext) => sql.begin((tx) => mailboxCodeAccess.list(tx, { principal: principal(context) }));
  const revoke = (id: string, grantId: string) => sql.begin((tx) => mailboxCodeAccess.revoke(tx, { id, grantId }));

  beforeAll(async () => {
    const uid = `c3c-owner-${suffix}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${uid}, 'local', 'user', 'Mailbox owner') RETURNING id`;
    if (!row) throw new Error("Missing owner");
    owner = {
      id: row.id,
      uid,
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: "Mailbox",
      sn: "Owner",
      displayName: "Mailbox owner",
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
    ownerContext = { actor: { kind: "user", user: owner }, accessSubject: { type: "user", userId: owner.id } };
    code = await createAccount("code", "first");
    otherCode = await createAccount("code", "second");
    ordinary = await createAccount("standalone", "ordinary");
    const [group] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`c3c-${suffix}`}, 'local', 'Code group') RETURNING id`;
    if (!group) throw new Error("Missing group");
    groupId = group.id;
    await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id)
      VALUES (${principal(code)}::uuid, ${groupId}::uuid), (${principal(ordinary)}::uuid, ${groupId}::uuid)`;
  });

  afterAll(async () => {
    for (const id of mailboxIds) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const row of rows) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    for (const id of ordinaryAccessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("sets independent grants at the public mailbox target; removal changes single and batched resolution immediately", async () => {
    const target = await mailbox();
    expect(await mailboxCodeAccess.manages(capabilityContext(ownerContext), target.shortId)).toBe(true);
    expect(await mailboxCodeAccess.manages(capabilityContext(code), target.shortId)).toBe(false);
    const read = await grant(target.shortId, code, ["mail.mailbox.read"]);
    const write = await grant(target.shortId, code, ["mail.draft.create"]);
    expect(read.decision).toMatchObject({ granted: true, level: "read" });
    expect(write.decision).toMatchObject({ granted: true, level: "write" });
    expect(await getMailboxPermission(code, target.id)).toBe("write");
    expect((await mailCapabilities.queries["mailbox.read"].run({ id: target.shortId }, capabilityContext(code))).ok).toBe(true);
    expect((await grant(target.shortId, code, ["mail.draft.create"], write.grantId)).decision).toEqual(write.decision);
    expect((await list(code)).filter((entry) => entry.id === target.shortId)).toHaveLength(2);
    const shares = await listMailboxAccess(ownerContext, target.id);
    if (!shares.ok) throw new Error(shares.error.message);
    expect(shares.data.find((entry) => entry.id === write.grantId)?.grantId).toBe(write.grantId);
    expect(shares.data.find((entry) => entry.principal.type === "user")?.grantId).toBeUndefined();
    const ordinaryRemoval = await revokeMailboxAccess({ context: ownerContext, mailboxId: target.id, accessId: write.grantId });
    expect(ordinaryRemoval.ok).toBe(false);
    if (!ordinaryRemoval.ok) expect(ordinaryRemoval.error.message).toContain("grantId");
    expect(
      (await updateMailboxAccess({ context: ownerContext, mailboxId: target.id, accessId: write.grantId, permission: "read" })).ok,
    ).toBe(false);
    expect(await getMailboxPermission(code, target.id)).toBe("write");
    expect(await revoke(target.shortId, write.grantId)).toBe(true);
    expect(await getMailboxPermission(code, target.id)).toBe("read");
    const writeRefused = await mailCapabilities.actions["mailbox.tag.create"].run(
      mailCapabilities.actions["mailbox.tag.create"].input.parse({ name: "Read-only Code", color: "#112233" }),
      { ...capabilityContext(code), target: { type: "mail.mailbox", id: target.shortId } },
    );
    expect(writeRefused.ok).toBe(false);
    if (!writeRefused.ok) expect(writeRefused.error.status).toBe(403);
    expect(await getMailboxAccesses(target.id, [code, otherCode, ownerContext])).toEqual([
      { scope: "mailbox", permission: "read" },
      null,
      { scope: "mailbox", permission: "admin" },
    ]);
    expect(await revoke(target.shortId, read.grantId)).toBe(true);
    expect(await getMailboxPermission(code, target.id)).toBe("none");
    expect(await getMailboxAccesses(target.id, [code])).toEqual([null]);
    expect(await revoke(target.shortId, read.grantId)).toBe(false);
    expect(await getMailboxPermission(ownerContext, target.id)).toBe("admin");
  });

  test("activation notices include concrete nested-group managers without expanding all-signed-in shares", async () => {
    const target = await mailbox();
    const [member] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile) VALUES(${`c9-manager-${suffix}`},'local','user') RETURNING id`;
    const [child] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups(cn,provider,name) VALUES(${`c9-managers-${suffix}`},'local','Nested managers') RETURNING id`;
    if (!member || !child) throw new Error("Missing manager fixture");
    try {
      await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${groupId}::uuid,${child.id}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${member.id}::uuid,${child.id}::uuid)`;
      const entries = await sql<{ id: string }[]>`INSERT INTO auth.access(group_id,authenticated_only,permission)
        VALUES(${groupId}::uuid,false,'admin'),(NULL,true,'admin') RETURNING id`;
      ordinaryAccessIds.push(...entries.map((row) => row.id));
      for (const entry of entries)
        await sql`INSERT INTO mail.mailbox_access(mailbox_id,access_id) VALUES(${target.id}::uuid,${entry.id}::uuid)`;
      const dry = (await grant(target.shortId, code, ["mail.mailbox.read"], crypto.randomUUID(), true)).decision;
      expect(dry.granted && new Set(dry.managerUserIds)).toEqual(new Set([owner.id, member.id]));
      expect((await list(code)).some((entry) => entry.id === target.shortId)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.groups WHERE id=${child.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${member.id}::uuid`;
    }
  });
  test("dry runs and refusals write nothing; wrong targets and ordinary shares cannot be removed", async () => {
    const target = await mailbox();
    const elsewhere = await mailbox();
    expect((await grant(target.shortId, code, ["mail.draft.create"], crypto.randomUUID(), true)).decision.granted).toBe(true);
    expect((await grant(target.shortId, code, [], crypto.randomUUID(), true)).decision.granted).toBe(true);
    for (const operations of [
      ["mail.draft.create", "mail.folder.display.set"],
      ["mail.conversation.keep.release"],
      ["spaces.task.create"],
      [],
    ])
      expect((await grant(target.shortId, code, operations)).decision.granted).toBe(false);
    expect((await grant(target.shortId, ordinary, ["mail.mailbox.read"])).decision.granted).toBe(false);
    expect((await list(code)).some((entry) => entry.id === target.shortId)).toBe(false);
    expect(await getMailboxPermission(code, target.id)).toBe("none");
    const granted = await grant(target.shortId, code, ["mail.mailbox.read"]);
    expect(await revoke(elsewhere.shortId, granted.grantId)).toBe(false);
    const [ownerGrant] = await sql<{ id: string }[]>`SELECT a.id FROM mail.mailbox_access ma JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${target.id}::uuid AND a.user_id = ${owner.id}::uuid`;
    if (!ownerGrant) throw new Error("Missing owner grant");
    expect(await revoke(target.shortId, ownerGrant.id)).toBe(false);
    expect((await grant(target.shortId, code, ["mail.draft.create"], ownerGrant.id)).decision.granted).toBe(false);
    expect(await getMailboxPermission(ownerContext, target.id)).toBe("admin");
    await sql`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${target.id}::uuid`;
    expect((await grant(target.shortId, code, ["mail.mailbox.read"])).decision.granted).toBe(false);
    expect(await revoke(target.shortId, granted.grantId)).toBe(true);
  });

  test("lists only this account's grants and ignores group, signed-in and public access for Code", async () => {
    const target = await mailbox();
    const first = await grant(target.shortId, code, ["mail.mailbox.read"]);
    const second = await grant(target.shortId, otherCode, ["mail.draft.create"]);
    const inherited = await sql<{ id: string }[]>`INSERT INTO auth.access (group_id, authenticated_only, permission)
      VALUES (${groupId}::uuid, false, 'write'), (NULL, true, 'write'), (NULL, false, 'write') RETURNING id`;
    ordinaryAccessIds.push(...inherited.map((row) => row.id));
    for (const row of inherited)
      await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${target.id}::uuid, ${row.id}::uuid)`;
    expect((await list(code)).filter((entry) => entry.id === target.shortId)).toEqual([
      { id: target.shortId, grantId: first.grantId, level: "read" },
    ]);
    expect((await list(otherCode)).filter((entry) => entry.id === target.shortId)).toEqual([
      { id: target.shortId, grantId: second.grantId, level: "write" },
    ]);
    expect(await list(ordinary)).toEqual([]);
    expect(await getMailboxPermission(code, target.id)).toBe("read");
    expect(await getMailboxPermission(ordinary, target.id)).toBe("write");
    expect(await getMailboxAccesses(target.id, [code, ordinary])).toEqual([
      { scope: "mailbox", permission: "read" },
      { scope: "mailbox", permission: "write" },
    ]);
    await revoke(target.shortId, first.grantId);
    expect(await getMailboxPermission(code, target.id)).toBe("none");
    expect(await getMailboxPermission(otherCode, target.id)).toBe("write");
    expect((await sql<{ mailbox_id: string }[]>`${readableMailboxGrants(code)}`).some((row) => row.mailbox_id === target.id)).toBe(false);
    const denied = await mailCapabilities.queries["mailbox.read"].run({ id: target.shortId }, capabilityContext(code));
    expect(denied.ok).toBe(false);
  });

  test("a Code admin row never substitutes for the last human administrator", async () => {
    const target = await mailbox();
    // Deliberately malformed legacy data must not let a human remove the last real admin.
    const [bad] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
      VALUES (${principal(code)}::uuid, 'admin') RETURNING id`;
    if (!bad) throw new Error("Missing malformed grant");
    await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${target.id}::uuid, ${bad.id}::uuid)`;
    const [admin] = await sql<{ id: string }[]>`SELECT a.id FROM mail.mailbox_access ma JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${target.id}::uuid AND a.user_id = ${owner.id}::uuid`;
    if (!admin) throw new Error("Missing admin");
    expect((await updateMailboxAccess({ context: ownerContext, mailboxId: target.id, accessId: admin.id, permission: "write" })).ok).toBe(
      false,
    );
    expect((await revokeMailboxAccess({ context: ownerContext, mailboxId: target.id, accessId: admin.id })).ok).toBe(false);
    expect(
      (
        await grantMailboxAccess({
          context: ownerContext,
          mailboxId: target.id,
          principal: { type: "service_account", serviceAccountId: principal(code) },
          permission: "admin",
        })
      ).ok,
    ).toBe(false);
    expect(await mailboxCodeAccess.manages(capabilityContext(code), target.shortId)).toBe(false);
    expect((await list(code)).some((entry) => entry.grantId === bad.id)).toBe(false);
  });
});
