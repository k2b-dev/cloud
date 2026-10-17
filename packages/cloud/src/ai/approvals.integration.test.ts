import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { AccessSubject } from "../contracts/shared";
import type { RequestActor } from "../server/middleware/auth";
import {
  type AiToolApprovalChangeContext,
  forgetAiToolApproval,
  listAiToolApprovalPreferences,
  rememberAiToolApproval,
  revokeAiToolApprovalPreference,
  revokeAiToolApprovalPreferencesAsSystem,
} from "./approvals";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";

const suite = databaseSuite();

type ApprovalAuditEventRow = {
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_uid: string | null;
  actor_provider: string | null;
  actor_roles: string[];
  target_type: string;
  target_id: string;
  target_label: string;
  request_id: string | null;
  reason: string | null;
  metadata: {
    toolName: string;
    approvalScope: string;
    remember: "chat" | "always";
    conversationId?: string;
    accessSubject: AccessSubject | null;
  };
};

const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string; uid: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`approval-audit-${suffix}`}, 'local', 'user', 'Approval Audit', ${`${suffix}@example.test`}, 'Approval', 'Audit')
    RETURNING id, uid
  `;
  const userId = user!.id;
  const actor: RequestActor = {
    kind: "user",
    user: {
      id: userId,
      uid: user!.uid,
      provider: "local",
      roles: ["user"],
      profile: "user",
      givenname: "Approval",
      sn: "Audit",
      displayName: "Approval Audit",
      mail: `${suffix}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    },
  };
  const delegatedByServiceAccountId = crypto.randomUUID();
  const accessSubject: AccessSubject = { type: "user", userId, delegatedByServiceAccountId };
  const context = {
    actorUserId: userId,
    actor,
    accessSubject,
    requestId: `approval-audit-${suffix}`,
  } satisfies AiToolApprovalChangeContext;
  const tool = { toolName: `audit-tool-${suffix}`, approvalScope: "items:write" };
  const events = () => sql<ApprovalAuditEventRow[]>`
    SELECT action, outcome, actor_user_id, actor_uid, actor_provider, actor_roles,
      target_type, target_id, target_label, request_id, reason, metadata
    FROM audit.events
    WHERE target_type = 'ai_approval' AND (
      actor_user_id = ${userId}::uuid OR target_id IN (
        SELECT target_id FROM audit.events WHERE actor_user_id = ${userId}::uuid AND target_type = 'ai_approval'
      )
    )
    ORDER BY id
  `;
  const preference = async (conversationId?: string) => (await listAiToolApprovalPreferences(userId, { conversationId }))[0]!;
  const cleanup = async () => {
    await sql`
      DELETE FROM audit.events
      WHERE target_type = 'ai_approval' AND (
        actor_user_id = ${userId}::uuid OR target_id IN (
          SELECT target_id FROM audit.events WHERE actor_user_id = ${userId}::uuid AND target_type = 'ai_approval'
        )
      )
    `;
    await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  };
  return { userId, actor, context, tool, events, preference, cleanup, delegatedByServiceAccountId };
};

suite("remembered approval audit integration", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("remember and revoke record exactly one event each with only approval metadata", async () => {
    const f = await fixture();
    try {
      await rememberAiToolApproval(f.context, f.tool);
      const preference = await f.preference();
      const expected: ApprovalAuditEventRow = {
        action: "ai.approval.remember",
        outcome: "allowed",
        actor_user_id: f.userId,
        actor_uid: f.actor.user.uid,
        actor_provider: "local",
        actor_roles: ["user"],
        target_type: "ai_approval",
        target_id: preference.id,
        target_label: f.tool.toolName,
        request_id: f.context.requestId,
        reason: null,
        metadata: { ...f.tool, remember: "always", accessSubject: f.context.accessSubject },
      };
      expect(await f.events()).toEqual([expected]);
      expect(await revokeAiToolApprovalPreference(f.context, preference.id)).toBe(true);
      expect(await f.events()).toEqual([expected, { ...expected, action: "ai.approval.revoke" }]);
      expect(await f.preference()).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  test("chat remember and forget map a delegated user and include only the chat ID", async () => {
    const f = await fixture();
    try {
      const [chat] = await sql<{ id: string }[]>`
        INSERT INTO ai.conversations (short_id, title, created_by_user_id)
        VALUES (${createAiShortId()}, 'Private chat text never enters audit', ${f.userId}::uuid) RETURNING id
      `;
      const actor: RequestActor = {
        kind: "service_account",
        delegatedUser: f.actor.user,
        scopes: [],
        serviceAccount: {
          id: f.delegatedByServiceAccountId,
          name: "Approval client",
          kind: "user_delegated",
          status: "active",
          delegatedUserId: f.userId,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: f.userId,
          createdAt: "2026-10-17T00:00:00.000Z",
        },
      };
      const context = { ...f.context, actor };
      const tool = { ...f.tool, conversationId: chat!.id };
      await rememberAiToolApproval(context, tool);
      const preference = await f.preference(chat!.id);
      expect(await forgetAiToolApproval(context, tool)).toBe(true);
      const events = await f.events();
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.action)).toEqual(["ai.approval.remember", "ai.approval.revoke"]);
      for (const event of events) {
        expect(event).toEqual({
          action: event.action,
          outcome: "allowed",
          actor_user_id: f.userId,
          actor_uid: f.actor.user.uid,
          actor_provider: "local",
          actor_roles: ["user"],
          target_type: "ai_approval",
          target_id: preference.id,
          target_label: f.tool.toolName,
          request_id: f.context.requestId,
          reason: null,
          metadata: { ...tool, remember: "chat", accessSubject: f.context.accessSubject },
        });
      }
      expect(await forgetAiToolApproval(context, tool)).toBe(false);
      expect(await f.events()).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });

  test("missing and foreign preferences do not emit revocations; missing identity records the owner", async () => {
    const f = await fixture();
    try {
      const context = { actorUserId: f.userId };
      await rememberAiToolApproval(context, f.tool);
      const preference = await f.preference();
      const [remembered] = await f.events();
      expect(remembered).toMatchObject({
        actor_user_id: f.userId,
        actor_uid: null,
        actor_provider: null,
        actor_roles: [],
        metadata: { ...f.tool, remember: "always", accessSubject: { type: "user", userId: f.userId } },
      });
      expect(await revokeAiToolApprovalPreference(context, crypto.randomUUID())).toBe(false);
      expect(await revokeAiToolApprovalPreference({ actorUserId: crypto.randomUUID() }, preference.id)).toBe(false);
      expect(await forgetAiToolApproval(context, { ...f.tool, approvalScope: "other" })).toBe(false);
      expect(await f.events()).toHaveLength(1);
      expect((await f.preference()).id).toBe(preference.id);
    } finally {
      await f.cleanup();
    }
  });

  test("an audit insert failure rolls back new grants, replacement grants, revoke, and forget", async () => {
    const f = await fixture();
    // PostgreSQL rejects a NUL byte in the audit request_id text column. Only this call is affected.
    const failing = { ...f.context, requestId: "invalid\u0000request" };
    try {
      await expect(rememberAiToolApproval(failing, f.tool)).rejects.toThrow();
      expect(await f.preference()).toBeUndefined();
      expect(await f.events()).toEqual([]);
      await rememberAiToolApproval(f.context, f.tool);
      const original = await f.preference();
      await expect(rememberAiToolApproval(failing, f.tool)).rejects.toThrow();
      expect(await f.preference()).toEqual(original);
      await expect(revokeAiToolApprovalPreference(failing, original.id)).rejects.toThrow();
      expect(await f.preference()).toEqual(original);
      await expect(forgetAiToolApproval(failing, f.tool)).rejects.toThrow();
      expect(await f.preference()).toEqual(original);
      expect(await f.events()).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test("system revocation uses the caller transaction, exact IDs, null identity, and a stable reason", async () => {
    const f = await fixture();
    try {
      const ids: string[] = [];
      for (const approvalScope of ["first", "second", "preserved"]) {
        await rememberAiToolApproval(f.context, { ...f.tool, approvalScope });
        const rows = await listAiToolApprovalPreferences(f.userId);
        ids.push(rows.find((row) => row.approvalScope === approvalScope)!.id);
      }
      const revokedIds = ids.slice(0, 2);
      const scopeById = new Map(ids.map((id, index) => [id, ["first", "second", "preserved"][index]!]));
      // A NUL in the reason fails this audit insert without altering shared database state.
      await expect(
        sql.begin((tx) =>
          revokeAiToolApprovalPreferencesAsSystem(tx, {
            ids: revokedIds,
            reason: "invalid\u0000reason",
          }),
        ),
      ).rejects.toThrow();
      expect(await listAiToolApprovalPreferences(f.userId)).toHaveLength(3);
      await expect(
        sql.begin(async (tx) => {
          await revokeAiToolApprovalPreferencesAsSystem(tx, { ids: revokedIds, reason: "approval_policy_migration" });
          throw new Error("caller rollback");
        }),
      ).rejects.toThrow("caller rollback");
      expect(await listAiToolApprovalPreferences(f.userId)).toHaveLength(3);
      expect(await f.events()).toHaveLength(3);
      expect(await sql.begin((tx) => revokeAiToolApprovalPreferencesAsSystem(tx, { ids: [], reason: "approval_policy_migration" }))).toBe(
        0,
      );
      expect(await f.events()).toHaveLength(3);
      expect(
        await sql.begin((tx) =>
          revokeAiToolApprovalPreferencesAsSystem(tx, {
            ids: [...revokedIds, revokedIds[0]!, crypto.randomUUID()],
            reason: "approval_policy_migration",
          }),
        ),
      ).toBe(2);
      const events = (await f.events()).filter((event) => event.action === "ai.approval.revoke");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.target_id).sort()).toEqual([...revokedIds].sort());
      for (const event of events) {
        expect(event).toEqual({
          action: "ai.approval.revoke",
          outcome: "allowed",
          actor_user_id: null,
          actor_uid: null,
          actor_provider: null,
          actor_roles: [],
          target_type: "ai_approval",
          target_id: event.target_id,
          target_label: f.tool.toolName,
          request_id: null,
          reason: "approval_policy_migration",
          metadata: { toolName: f.tool.toolName, approvalScope: scopeById.get(event.target_id)!, remember: "always", accessSubject: null },
        });
      }
      expect((await listAiToolApprovalPreferences(f.userId)).map((row) => row.id)).toEqual([ids[2]!]);
      expect(
        await sql.begin((tx) =>
          revokeAiToolApprovalPreferencesAsSystem(tx, {
            ids: revokedIds,
            reason: "approval_policy_migration",
          }),
        ),
      ).toBe(0);
      expect(await f.events()).toHaveLength(5);
    } finally {
      await f.cleanup();
    }
  });
});
