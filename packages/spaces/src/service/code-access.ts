import type { CodeAccessAdapter, CodeAccessDecision } from "@k2b/cloud";
import { CODE_ACCESS_MAX_MANAGER_USER_IDS } from "@k2b/cloud/contracts";
import { buildAccessPrincipalCondition, getEffectivePermission } from "@k2b/cloud/server";
import type { SQL } from "bun";
import { ResourceShortIdSchema } from "../contracts";
import { publishSpaceChange } from "./live";

/** Minimum Space level per capability. null means Code cannot use the operation at this target. */
export const SPACES_CODE_OPERATION_LEVELS = {
  "space.containers": "read",
  "space.activity": "read",
  "task.work.read": "read",
  "space.search": "read",
  "item.search": "read",
  "item.link-candidate.search": "write",
  "task.focus": "read",
  "calendar.list": "read",
  "calendar.events": "read",
  "event.agenda": "read",
  "space.browse": "read",
  "task.checklist.list": "read",
  "space.list": "read",
  "space.read": "read",
  "template.list": "read",
  "template.read": "read",
  "space.assignee.list": "write",
  "task.list": "read",
  "event.list": "read",
  "item.read": "read",
  "item.reference.find": "read",
  "item.reference.list": "read",
  "task.blocker.list": "read",
  "task.blocks.list": "read",
  "comment.list": "read",
  "comment.read": "read",
  "calendar-invitation.preview": "read",
  "calendar-destination.list": "write",
  "calendar-invitation.response.prepare": "write",
  "task.claim": "write",
  "task.release": "write",
  "task.progress": "write",
  "task.checklist.create": "write",
  "task.checklist.update": "write",
  "task.checklist.delete": "write",
  "item.reference.add": "write",
  "item.reference.remove": "write",
  "item.tags.set": "write",
  "task.blocker.add": "write",
  "task.blocker.remove": "write",
  "template.create": null,
  "template.update": null,
  "template.delete": null,
  "task.create": "write",
  "task.update": "write",
  "task.set-completed": "write",
  "event.create": "write",
  "event.update": "write",
  "event.invitation.prepare": null,
  "event.invitation.commit": null,
  "item.delete": "write",
  "reaction.add": "write",
  "reaction.remove": "write",
  "comment.create": "write",
  "comment.update": null,
  "comment.delete": null,
  "calendar-invitation.import": "write",
  "calendar-invitation.response.commit": null,
} as const;

/** Refuse unknown, foreign, manager-only and person-only operations as one request. */
export const spaceCodeAccessDecision = (operations: readonly string[], dryRun: boolean): CodeAccessDecision => {
  if (!operations.length && !dryRun) return { granted: false, reason: "Spaces requires at least one operation." };
  let level: "read" | "write" = "read";
  const levels: Readonly<Record<string, "read" | "write" | null>> = SPACES_CODE_OPERATION_LEVELS;
  for (const operation of operations) {
    const required =
      operation.startsWith("spaces.") && Object.hasOwn(levels, operation.slice("spaces.".length))
        ? levels[operation.slice("spaces.".length)]
        : undefined;
    if (!required) return { granted: false, reason: `Spaces cannot grant a non-manager Code level for ${operation}.` };
    if (required === "write") level = "write";
  }
  return { granted: true, level };
};

/** Target edits take FOR UPDATE; shared locks compose across multi-target Code listings. */
const lockTarget = async (tx: SQL, id: string) => {
  const [target] = await tx<{ id: string }[]>`
    SELECT id FROM spaces.spaces WHERE short_id = ${id} FOR SHARE
  `;
  return target ?? null;
};

/** Expand current person managers, respecting the directory's same-provider nesting rule.
 * Service accounts never count as people managing the target.
 */
const managerUserIds = async (tx: SQL, id: string): Promise<string[] | null> => {
  const rows = await tx<{ id: string }[]>`
    WITH RECURSIVE manager_grants AS (
      SELECT a.* FROM auth.access a JOIN spaces.space_access grants ON grants.access_id = a.id
      WHERE grants.space_id = ${id}::uuid AND a.permission = 'admin'
    ), manager_groups AS (
      SELECT g.id, g.provider FROM manager_grants a JOIN auth.groups g ON g.id = a.group_id
      UNION
      SELECT child.id, child.provider FROM manager_groups parent
      JOIN auth.group_groups_v2 edge ON edge.parent_group_id = parent.id
      JOIN auth.groups child ON child.id = edge.child_group_id AND child.provider = parent.provider
    ), manager_users AS (
      SELECT user_id AS id FROM manager_grants WHERE user_id IS NOT NULL
      UNION
      SELECT membership.user_id FROM auth.user_groups_v2 membership JOIN manager_groups g ON g.id = membership.group_id
      UNION
      SELECT id FROM auth.users WHERE EXISTS (
        SELECT 1 FROM manager_grants WHERE user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL
      )
    )
    SELECT u.id FROM auth.users u JOIN manager_users managers ON managers.id = u.id
    WHERE u.account_expires IS NULL OR u.account_expires > statement_timestamp()
    ORDER BY u.id LIMIT ${CODE_ACCESS_MAX_MANAGER_USER_IDS + 1}
  `;
  return rows.length > CODE_ACCESS_MAX_MANAGER_USER_IDS ? null : rows.map((row) => row.id);
};

/** Core owns proof validation, admission, transaction, grant tombstones and audit. Spaces owns the live share. */
export const spaceCodeAccess: CodeAccessAdapter = {
  manages: async (tx, context, id) => {
    if (
      context.actor.kind !== "user" ||
      context.accessSubject.type !== "user" ||
      context.accessSubject.userId !== context.actor.user.id ||
      !ResourceShortIdSchema.safeParse(id).success
    )
      return false;
    // Match platform lock order: current person before target and directory authority.
    const [person] = await tx`SELECT id FROM auth.users WHERE id = ${context.actor.user.id}::uuid
      AND (account_expires IS NULL OR account_expires > statement_timestamp()) FOR SHARE`;
    if (!person) return false;
    // Do not wait on directory writers while holding a person/projection lock:
    // IPA sync writes users and memberships before its role projection. A busy
    // directory rolls this Code transaction back; it must never abort the sync.
    await tx`LOCK TABLE auth.groups, auth.group_groups_v2, auth.user_groups_v2 IN SHARE MODE NOWAIT`;
    const target = await lockTarget(tx, id);
    if (!target) return false;
    const matches = buildAccessPrincipalCondition({
      subject: context.accessSubject,
      columns: {
        userId: tx`a.user_id`,
        groupId: tx`a.group_id`,
        serviceAccountId: tx`a.service_account_id`,
        authenticatedOnly: tx`a.authenticated_only`,
      },
    });
    // Lock only this person's supporting shares. An unrelated person's deletion
    // can cascade through other shares before waiting on directory membership.
    const admins = await tx<{ id: string }[]>`SELECT a.id FROM auth.access a
      JOIN spaces.space_access grants ON grants.access_id = a.id
      WHERE grants.space_id = ${target.id}::uuid AND a.permission = 'admin' AND ${matches}
      ORDER BY a.id FOR SHARE OF a, grants`;
    return (await getEffectivePermission({ accessIds: admins.map((row) => row.id), subject: context.accessSubject }, tx)) === "admin";
  },
  grant: async (tx, input) => {
    const decision = spaceCodeAccessDecision(input.operations, input.dryRun);
    if (!decision.granted) return decision;
    if (!ResourceShortIdSchema.safeParse(input.id).success) return { granted: false, reason: "Space not found." };
    const space = await lockTarget(tx, input.id);
    if (!space) return { granted: false, reason: "Space not found." };
    // Core needs recipients only in preflight; a large list must refuse before writes.
    const managers = input.dryRun ? await managerUserIds(tx, space.id) : undefined;
    if (managers === null) return { granted: false, reason: "Too many target managers for the Code access response budget." };
    const granted = managers ? { ...decision, managerUserIds: managers } : decision;
    const [account] = await tx`
      SELECT id FROM auth.service_accounts WHERE id = ${input.principal}::uuid AND kind = 'code' AND status = 'active' FOR SHARE
    `;
    if (!account) return { granted: false, reason: "An active Code account is required." };
    // Each activation gets its own access row, including overlapping grants at one space.
    // Never replace another grant or an ordinary share on an identity collision.
    const [existing] = await tx<{ service_account_id: string | null; permission: string; space_id: string | null }[]>`
      SELECT a.service_account_id, a.permission, sa.space_id
      FROM auth.access a LEFT JOIN spaces.space_access sa ON sa.access_id = a.id
      WHERE a.id = ${input.grantId}::uuid
    `;
    if (existing) {
      return existing.service_account_id === input.principal && existing.space_id === space.id && existing.permission === decision.level
        ? granted
        : { granted: false, reason: "Grant identity already belongs to another share." };
    }
    if (input.dryRun) return granted;
    await tx`INSERT INTO auth.access (id, service_account_id, permission)
      VALUES (${input.grantId}::uuid, ${input.principal}::uuid, ${decision.level}::auth.permission_level)`;
    await tx`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${input.grantId}::uuid)`;
    await publishSpaceChange(tx, { type: "access.changed", spaceId: space.id });
    return granted;
  },
  revoke: async (tx, { id, grantId }) => {
    if (!ResourceShortIdSchema.safeParse(id).success) return false;
    const target = await lockTarget(tx, id);
    if (!target) return false;
    const removed = await tx<{ space_id: string }[]>`
      DELETE FROM auth.access a USING spaces.space_access sa, spaces.spaces space, auth.service_accounts account
      WHERE a.id = ${grantId}::uuid AND sa.access_id = a.id AND sa.space_id = space.id AND space.short_id = ${id}
        AND account.id = a.service_account_id AND account.kind = 'code'
      RETURNING sa.space_id
    `;
    for (const row of removed) await publishSpaceChange(tx, { type: "access.changed", spaceId: row.space_id });
    return removed.length > 0;
  },
  list: async (tx, { principal }) =>
    tx<{ grantId: string; id: string; level: "read" | "write" }[]>`
      SELECT a.id AS "grantId", space.short_id AS id, a.permission AS level
      FROM spaces.space_access sa
      JOIN auth.access a ON a.id = sa.access_id
      JOIN auth.service_accounts account ON account.id = a.service_account_id AND account.kind = 'code'
      JOIN spaces.spaces space ON space.id = sa.space_id
      WHERE a.service_account_id = ${principal}::uuid AND a.permission IN ('read', 'write')
      ORDER BY space.short_id, a.id
    `,
};
