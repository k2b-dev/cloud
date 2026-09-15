import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { __notificationBatchTest, notificationBatches } from "./batches";

const canUseAuthDatabase = async () => {
  try {
    const [row] = await sql<
      {
        users: string | null;
        groups: string | null;
        user_groups: string | null;
        group_groups: string | null;
      }[]
    >`
      SELECT
        to_regclass('auth.users')::text AS users,
        to_regclass('auth.groups')::text AS groups,
        to_regclass('auth.user_groups_v2')::text AS user_groups,
        to_regclass('auth.group_groups_v2')::text AS group_groups
    `;
    return Boolean(row?.users && row.groups && row.user_groups && row.group_groups);
  } catch {
    return false;
  }
};

const canUseNotificationBatchDatabase = async () => {
  if (!(await canUseAuthDatabase())) return false;
  try {
    const [row] = await sql<
      {
        batches: string | null;
        batch_recipients: string | null;
      }[]
    >`
      SELECT
        to_regclass('notifications.batches')::text AS batches,
        to_regclass('notifications.batch_recipients')::text AS batch_recipients
    `;
    return Boolean(row?.batches && row.batch_recipients);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const databaseAvailable = (await canUseAuthDatabase()) && (await canUseNotificationBatchDatabase());
if (process.env.CLOUD_DATABASE_TEST === "1" && !databaseAvailable) {
  throw new Error("Required authorization test database is unavailable or not migrated");
}
const suite = databaseAvailable ? describe : describe.skip;

const insertUser = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (
      ${`notification-batch-${label}-${suffix}`},
      'local',
      'user',
      ${`Notification ${label}`},
      ${`notification-batch-${label}-${suffix}@example.test`},
      'Notification',
      ${label}
    )
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${`notification-batch-${label}-${suffix}`}, 'local', ${`Notification ${label} ${suffix}`}, 'notification batch test')
    RETURNING id
  `;
  return row!.id;
};

const cleanupAuthFixture = async (userIds: string[], groupIds: string[]) => {
  for (const groupId of groupIds) {
    await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${groupId}::uuid OR child_group_id = ${groupId}::uuid`;
    await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
  }
  for (const groupId of groupIds) {
    await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
  }
  for (const userId of userIds) {
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
};

suite("notification batch selections", () => {
  test("normalizes duplicate and unordered ids for stable drafts", () => {
    const selection = __notificationBatchTest.normalizeSelection({
      userIds: ["user-b", "user-a", "user-a"],
      groupIds: ["group-b", "group-a"],
    });

    expect(selection.userIds).toEqual(["user-a", "user-b"]);
    expect(selection.groupIds).toEqual(["group-a", "group-b"]);
  });

  test("drops legacy rule-only selection fields", () => {
    const selection = __notificationBatchTest.normalizeSelection({
      mode: "rules",
      rules: ["ipa", "account_manager"],
    } as never);

    expect(selection).toEqual({ userIds: [], groupIds: [] });
  });

  test("blocks broad legacy audiences but allows compatible explicit drafts", () => {
    expect(
      __notificationBatchTest.hasLegacyAudienceSelection({
        mode: "specific",
        userIds: ["user-a"],
        rules: [],
        all: false,
        includeGroupMembers: true,
        accountManagers: { mode: "none", groupIds: [], recursive: true },
        providers: [],
        profiles: [],
      } as never),
    ).toBe(false);

    expect(
      __notificationBatchTest.hasLegacyAudienceSelection({
        mode: "rules",
        rules: ["account_manager"],
      } as never),
    ).toBe(true);

    expect(
      __notificationBatchTest.hasLegacyAudienceSelection({
        userIds: ["user-a"],
        providers: ["ipa"],
      } as never),
    ).toBe(true);
  });

  test("keeps selection hash stable across duplicate and order-only changes", () => {
    const left = __notificationBatchTest.selectionHash({
      userIds: ["user-b", "user-a", "user-a"],
      groupIds: ["group-b", "group-a", "group-a"],
    });
    const right = __notificationBatchTest.selectionHash({
      groupIds: ["group-a", "group-b"],
      userIds: ["user-a", "user-b"],
    });

    expect(left).toBe(right);
  });

  test("hashes deliverable recipients by user id only", () => {
    const left = __notificationBatchTest.recipientHash([
      { id: "user-b", uid: "b", display_name: "B", mail: "b@example.test", provider: "local", profile: "user", source_hits: 1 },
      { id: "user-a", uid: "a", display_name: "A", mail: "a@example.test", provider: "local", profile: "user", source_hits: 1 },
      { id: "user-c", uid: "c", display_name: "C", mail: null, provider: "local", profile: "user", source_hits: 1 },
    ]);
    const right = __notificationBatchTest.recipientHash([
      {
        id: "user-a",
        uid: "changed",
        display_name: "Changed",
        mail: "changed@example.test",
        provider: "ipa",
        profile: "guest",
        source_hits: 3,
      },
      { id: "user-b", uid: "b", display_name: "B", mail: "b@example.test", provider: "local", profile: "user", source_hits: 1 },
    ]);

    expect(left).toBe(right);
  });

  test("resolves explicit users and recursive group members", async () => {
    const suffix = crypto.randomUUID();
    const explicitUserId = await insertUser(suffix, "explicit-user");
    const directMemberId = await insertUser(suffix, "direct-member");
    const nestedMemberId = await insertUser(suffix, "nested-member");
    const parentGroupId = await insertGroup(suffix, "parent-group");
    const childGroupId = await insertGroup(suffix, "child-group");
    const userIds = [explicitUserId, directMemberId, nestedMemberId];
    const groupIds = [parentGroupId, childGroupId];

    try {
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${explicitUserId}::uuid, ${parentGroupId}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${directMemberId}::uuid, ${parentGroupId}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedMemberId}::uuid, ${childGroupId}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)`;

      const candidates = await __notificationBatchTest.resolveCandidates({
        userIds: [explicitUserId],
        groupIds: [parentGroupId],
      });
      const candidateIds = candidates.map((candidate) => candidate.id);

      expect(candidateIds).toContain(explicitUserId);
      expect(candidateIds).toContain(directMemberId);
      expect(candidateIds).toContain(nestedMemberId);
      expect(candidates.find((candidate) => candidate.id === explicitUserId)?.source_hits).toBe(2);
    } finally {
      await cleanupAuthFixture(userIds, groupIds);
    }
  });

  test("finalize rejects legacy rule drafts without creating a recipient snapshot", async () => {
    const suffix = crypto.randomUUID();
    const actorId = await insertUser(suffix, "legacy-actor");
    const legacySelection = { mode: "rules", rules: ["account_manager"] };
    const selectionHash = __notificationBatchTest.selectionHash(legacySelection as never);
    const [batch] = await sql<{ id: string }[]>`
      INSERT INTO notifications.batches (subject, body_markdown, body_html, selection, selection_hash, created_by)
      VALUES (
        'Legacy rule draft',
        'Body',
        '<p>Body</p>',
        ${JSON.stringify(legacySelection)}::jsonb,
        ${selectionHash},
        ${actorId}::uuid
      )
      RETURNING id
    `;

    try {
      const result = await notificationBatches.finalize({
        id: batch!.id,
        actorUserId: actorId,
        expectedSelectionHash: selectionHash,
        expectedDeliverableCount: 0,
        expectedRecipientHash: "unused",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Legacy notification drafts cannot be finalized");

      const [recipientCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM notifications.batch_recipients
        WHERE batch_id = ${batch!.id}::uuid
      `;
      expect(Number(recipientCount?.count ?? 0)).toBe(0);

      const [storedBatch] = await sql<{ status: string; finalized_at: Date | null }[]>`
        SELECT status, finalized_at
        FROM notifications.batches
        WHERE id = ${batch!.id}::uuid
      `;
      expect(storedBatch?.status).toBe("draft");
      expect(storedBatch?.finalized_at).toBeNull();
    } finally {
      await sql`DELETE FROM notifications.batches WHERE id = ${batch!.id}::uuid`;
      await cleanupAuthFixture([actorId], []);
    }
  });
});
