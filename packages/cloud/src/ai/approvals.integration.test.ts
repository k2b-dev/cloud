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
    serviceAccountId?: string;
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
  const accessSubject: AccessSubject = { type: "user", userId };
  const context = {
    actorUserId: userId,
    actor,
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
  return { userId, actor, context, tool, events, preference, cleanup, accessSubject };
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
        metadata: { ...f.tool, remember: "always", accessSubject: f.accessSubject },
      };
      expect(await f.events()).toEqual([expected]);
      expect(await revokeAiToolApprovalPreference(f.userId, preference.id, f.context)).toBe(true);
      expect(await f.events()).toEqual([expected, { ...expected, action: "ai.approval.revoke" }]);
      expect(await f.preference()).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  test.each(["always", "chat"] as const)(
    "re-remembering the same %s reach keeps its ID and records only remember events",
    async (reach) => {
      const f = await fixture();
      try {
        let conversationId: string | undefined;
        if (reach === "chat") {
          const [chat] = await sql<{ id: string }[]>`
          INSERT INTO ai.conversations (short_id, title, created_by_user_id)
          VALUES (${createAiShortId()}, 'Approval reach', ${f.userId}::uuid) RETURNING id
        `;
          conversationId = chat!.id;
        }
        const tool = { ...f.tool, conversationId };
        await rememberAiToolApproval(f.context, tool);
        const original = await f.preference(conversationId);
        const oldTimestamp = "2000-01-01T00:00:00.000Z";
        await sql`
        UPDATE ai.tool_approval_preferences
        SET created_at = ${oldTimestamp}::timestamptz,
            last_used_at = ${oldTimestamp}::timestamptz,
            expires_at = ${oldTimestamp}::timestamptz
        WHERE id = ${original.id}::uuid
      `;

        await rememberAiToolApproval(f.context, tool);
        const remembered = await f.preference(conversationId);
        expect(remembered.id).toBe(original.id);
        expect(remembered.createdAt).not.toBe(oldTimestamp);
        expect(remembered.lastUsedAt).toBe(remembered.createdAt);
        expect(remembered.expiresAt).toBeNull();
        const events = await f.events();
        expect(events).toHaveLength(2);
        expect(events.map((event) => [event.action, event.target_id])).toEqual([
          ["ai.approval.remember", original.id],
          ["ai.approval.remember", original.id],
        ]);
      } finally {
        await f.cleanup();
      }
    },
  );

  test("API-key chat remember and forget derive the delegated identity from the actor", async () => {
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
          id: crypto.randomUUID(),
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
      const context = { actorUserId: f.userId, actor, requestId: f.context.requestId } satisfies AiToolApprovalChangeContext;
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
          metadata: {
            ...tool,
            remember: "chat",
            accessSubject: { type: "user", userId: f.userId, delegatedByServiceAccountId: actor.serviceAccount.id },
            serviceAccountId: actor.serviceAccount.id,
          },
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
      expect(await revokeAiToolApprovalPreference(f.userId, crypto.randomUUID())).toBe(false);
      expect(await revokeAiToolApprovalPreference(crypto.randomUUID(), preference.id)).toBe(false);
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
      await expect(revokeAiToolApprovalPreference(f.userId, original.id, failing)).rejects.toThrow();
      expect(await f.preference()).toEqual(original);
      await expect(forgetAiToolApproval(failing, f.tool)).rejects.toThrow();
      expect(await f.preference()).toEqual(original);
      expect(await f.events()).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test("system revocation uses the caller transaction, exact IDs, null actor, owner subject, and a stable reason", async () => {
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
          metadata: {
            toolName: f.tool.toolName,
            approvalScope: scopeById.get(event.target_id)!,
            remember: "always",
            accessSubject: { type: "user", userId: f.userId },
          },
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
