import { type CodeAccessAdapter, type CodeAccessDecision, sql } from "@k2b/cloud";
import { ResourceShortIdSchema } from "../contracts";
import { getSpacePermission } from "./access";
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

/** Core owns proof validation, admission, transaction, grant tombstones and audit. Spaces owns the live share. */
export const spaceCodeAccess: CodeAccessAdapter = {
  manages: async (context, id) => {
    if (context.actor.kind !== "user" || context.accessSubject.type !== "user" || !ResourceShortIdSchema.safeParse(id).success)
      return false;
    const [space] = await sql<{ id: string }[]>`
      SELECT id FROM spaces.spaces WHERE short_id = ${id}
    `;
    return Boolean(space && (await getSpacePermission({ spaceId: space.id, subject: context.accessSubject })) === "admin");
  },
  grant: async (tx, input) => {
    const decision = spaceCodeAccessDecision(input.operations, input.dryRun);
    if (!decision.granted) return decision;
    if (!ResourceShortIdSchema.safeParse(input.id).success) return { granted: false, reason: "Space not found." };
    const [space] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.spaces WHERE short_id = ${input.id} FOR UPDATE
    `;
    if (!space) return { granted: false, reason: "Space not found." };
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
        ? decision
        : { granted: false, reason: "Grant identity already belongs to another share." };
    }
    if (input.dryRun) return decision;
    await tx`INSERT INTO auth.access (id, service_account_id, permission)
      VALUES (${input.grantId}::uuid, ${input.principal}::uuid, ${decision.level}::auth.permission_level)`;
    await tx`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${input.grantId}::uuid)`;
    await publishSpaceChange(tx, { type: "access.changed", spaceId: space.id });
    return decision;
  },
  revoke: async (tx, { id, grantId }) => {
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
