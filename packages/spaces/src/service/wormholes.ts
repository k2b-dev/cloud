import { type AccessSubject, hasPermission, listUsersWithAccess, type PermissionLevel } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  CreateWormhole,
  MutationResult,
  SpaceWormhole,
  SpaceWormholeDestination,
  SpaceWormholeTarget,
  UpdateWormhole,
  User,
  WormholeTransferResult,
} from "@/contracts";
import { withShortId } from "../lib/short-id";
import { buildSpacePrincipalCondition, getSpacePermission } from "./access";
import * as columns from "./columns";
import { publishSpaceEvent } from "./events";
import { get as getItem } from "./items";
import { rank } from "./rank";
import * as spaces from "./spaces";

export type WormholeActor = {
  subject: AccessSubject;
  resourceBoundSpaceId: string | null;
};

export const actorForUser = (user: Pick<User, "id">): WormholeActor => ({
  subject: { type: "user", userId: user.id },
  resourceBoundSpaceId: null,
});

type DbWormhole = {
  id: string;
  source_space_id: string;
  target_column_id: string;
  color: string;
  rank: string;
  created_at: Date;
  updated_at: Date;
  target_space_id: string;
  target_space_name: string;
  target_space_color: string;
  target_column_name: string;
  target_column_is_done: boolean;
};

const targetFromRow = (row: DbWormhole): SpaceWormholeTarget => ({
  spaceId: row.target_space_id,
  spaceName: row.target_space_name,
  spaceColor: row.target_space_color,
  columnId: row.target_column_id,
  columnName: row.target_column_name,
  columnIsDone: row.target_column_is_done,
});

const mapWormhole = (row: DbWormhole, includeTarget = true): SpaceWormhole => ({
  id: row.id,
  sourceSpaceId: row.source_space_id,
  color: row.color,
  rank: row.rank,
  target: includeTarget ? targetFromRow(row) : null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const canAccess = async (spaceId: string, actor: WormholeActor, requiredLevel: PermissionLevel): Promise<boolean> => {
  if (actor.resourceBoundSpaceId && actor.resourceBoundSpaceId !== spaceId) return false;
  const permission = await getSpacePermission({ spaceId, subject: actor.subject });
  return hasPermission(permission, requiredLevel);
};

const denied = <T>(): MutationResult<T> => ({ ok: false, error: "Access denied", status: 403 });

const listRows = async (sourceSpaceId: string): Promise<DbWormhole[]> =>
  sql<DbWormhole[]>`
    SELECT
      w.id,
      w.source_space_id,
      w.target_column_id,
      w.color,
      w.rank::text AS rank,
      w.created_at,
      w.updated_at,
      target.id AS target_space_id,
      target.name AS target_space_name,
      target.color AS target_space_color,
      c.name AS target_column_name,
      c.is_done AS target_column_is_done
    FROM spaces.wormholes w
    JOIN spaces.columns c ON c.id = w.target_column_id
    JOIN spaces.spaces target ON target.id = c.space_id
    WHERE w.source_space_id = ${sourceSpaceId}::uuid
    ORDER BY w.rank, w.id
  `;

const getRow = async (params: { sourceSpaceId: string; id: string }): Promise<DbWormhole | null> => {
  const rows = await listRows(params.sourceSpaceId);
  return rows.find((row) => row.id === params.id) ?? null;
};

/** Wormholes shown as actions are filtered by the actor's current write access to both sides. */
export const listUsable = async (params: { sourceSpaceId: string; actor: WormholeActor }): Promise<SpaceWormhole[]> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "write"))) return [];
  const rows = await listRows(params.sourceSpaceId);
  const visible = await Promise.all(
    rows.map(async (row) => ((await canAccess(row.target_space_id, params.actor, "write")) ? mapWormhole(row) : null)),
  );
  return visible.filter((wormhole): wormhole is SpaceWormhole => wormhole !== null);
};

/** Source admins can always remove stale links, but target details stay hidden without target admin access. */
export const listConfigured = async (params: { sourceSpaceId: string; actor: WormholeActor }): Promise<MutationResult<SpaceWormhole[]>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  const rows = await listRows(params.sourceSpaceId);
  const items = await Promise.all(rows.map(async (row) => mapWormhole(row, await canAccess(row.target_space_id, params.actor, "admin"))));
  return { ok: true, data: items };
};

export const listDestinations = async (params: {
  sourceSpaceId: string;
  actor: WormholeActor;
}): Promise<MutationResult<SpaceWormholeDestination[]>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  if (params.actor.resourceBoundSpaceId) return { ok: true, data: [] };
  const targetSpaces = await spaces.list({ subject: params.actor.subject, requiredLevel: "admin" });
  const available = targetSpaces.filter((space) => space.id !== params.sourceSpaceId);
  const destinations = await Promise.all(
    available.map(async (space) => ({
      spaceId: space.id,
      spaceName: space.name,
      spaceColor: space.color,
      columns: await columns.list({ spaceId: space.id }),
    })),
  );
  return { ok: true, data: destinations.filter((destination) => destination.columns.length > 0) };
};

const resolveTargetColumn = async (targetColumnId: string) => {
  const column = await columns.get({ id: targetColumnId });
  return column ? { column, targetSpaceId: column.spaceId } : null;
};

export const create = async (params: {
  sourceSpaceId: string;
  data: CreateWormhole;
  actor: WormholeActor;
}): Promise<MutationResult<SpaceWormhole>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  const target = await resolveTargetColumn(params.data.targetColumnId);
  if (!target) return { ok: false, error: "Destination column not found", status: 404 };
  if (target.targetSpaceId === params.sourceSpaceId) {
    return { ok: false, error: "A wormhole must lead to another space", status: 400 };
  }
  if (!(await canAccess(target.targetSpaceId, params.actor, "admin"))) return denied();

  const createdId = await withShortId("wormhole", (shortId) =>
    sql.begin(async (tx): Promise<string | "duplicate" | null> => {
      const [source] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.spaces WHERE id = ${params.sourceSpaceId}::uuid FOR UPDATE
    `;
      const [lockedTarget] = await tx<{ space_id: string }[]>`
      SELECT space_id FROM spaces.columns WHERE id = ${params.data.targetColumnId}::uuid FOR KEY SHARE
    `;
      if (!source || !lockedTarget || lockedTarget.space_id !== target.targetSpaceId) return null;

      const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.wormholes
      WHERE source_space_id = ${params.sourceSpaceId}::uuid
        AND target_column_id = ${params.data.targetColumnId}::uuid
    `;
      if (existing) return "duplicate";

      const [maxRow] = await tx<{ max: string | null }[]>`
      SELECT MAX(rank)::text AS max FROM spaces.wormholes WHERE source_space_id = ${params.sourceSpaceId}::uuid
    `;
      const [created] = await tx<{ id: string }[]>`
      INSERT INTO spaces.wormholes (short_id, source_space_id, target_column_id, color, rank)
      VALUES (
        ${shortId},
        ${params.sourceSpaceId}::uuid,
        ${params.data.targetColumnId}::uuid,
        ${params.data.color},
        ${rank.toDb(rank.next(maxRow?.max))}::bigint
      )
      RETURNING id
    `;
      return created?.id ?? null;
    }),
  );

  if (createdId === "duplicate") return { ok: false, error: "This wormhole already exists", status: 409 };
  if (!createdId) return { ok: false, error: "Could not create wormhole", status: 404 };
  const created = await getRow({ sourceSpaceId: params.sourceSpaceId, id: createdId });
  if (!created) return { ok: false, error: "Could not load created wormhole", status: 500 };
  await publishSpaceEvent({ type: "wormhole.created", spaceId: params.sourceSpaceId, wormholeId: created.id });
  return { ok: true, data: mapWormhole(created) };
};

export const update = async (params: {
  sourceSpaceId: string;
  id: string;
  data: UpdateWormhole;
  actor: WormholeActor;
}): Promise<MutationResult<SpaceWormhole>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  const existing = await getRow({ sourceSpaceId: params.sourceSpaceId, id: params.id });
  if (!existing) return { ok: false, error: "Wormhole not found", status: 404 };

  const targetColumnId = params.data.targetColumnId ?? existing.target_column_id;
  const target = await resolveTargetColumn(targetColumnId);
  if (!target) return { ok: false, error: "Destination column not found", status: 404 };
  if (target.targetSpaceId === params.sourceSpaceId) {
    return { ok: false, error: "A wormhole must lead to another space", status: 400 };
  }
  if (!(await canAccess(target.targetSpaceId, params.actor, "admin"))) return denied();

  const updatedId = await sql.begin(async (tx): Promise<string | "duplicate" | null> => {
    const [source] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.spaces WHERE id = ${params.sourceSpaceId}::uuid FOR UPDATE
    `;
    if (!source) return null;
    const [lockedTarget] = await tx<{ space_id: string }[]>`
      SELECT space_id FROM spaces.columns WHERE id = ${targetColumnId}::uuid FOR KEY SHARE
    `;
    if (!lockedTarget || lockedTarget.space_id !== target.targetSpaceId) return null;
    const [locked] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.wormholes
      WHERE id = ${params.id}::uuid AND source_space_id = ${params.sourceSpaceId}::uuid
      FOR UPDATE
    `;
    if (!locked) return null;
    const [duplicate] = await tx<{ id: string }[]>`
      SELECT id FROM spaces.wormholes
      WHERE source_space_id = ${params.sourceSpaceId}::uuid
        AND target_column_id = ${targetColumnId}::uuid
        AND id <> ${params.id}::uuid
    `;
    if (duplicate) return "duplicate";
    const [updated] = await tx<{ id: string }[]>`
      UPDATE spaces.wormholes
      SET target_column_id = ${targetColumnId}::uuid,
          color = ${params.data.color ?? existing.color},
          updated_at = now()
      WHERE id = ${params.id}::uuid AND source_space_id = ${params.sourceSpaceId}::uuid
      RETURNING id
    `;
    return updated?.id ?? null;
  });

  if (updatedId === "duplicate") return { ok: false, error: "This wormhole already exists", status: 409 };
  if (!updatedId) return { ok: false, error: "Wormhole not found", status: 404 };
  const updated = await getRow({ sourceSpaceId: params.sourceSpaceId, id: updatedId });
  if (!updated) return { ok: false, error: "Could not load updated wormhole", status: 500 };
  await publishSpaceEvent({ type: "wormhole.updated", spaceId: params.sourceSpaceId, wormholeId: updated.id });
  return { ok: true, data: mapWormhole(updated) };
};

export const reorder = async (params: {
  sourceSpaceId: string;
  wormholeIds: string[];
  actor: WormholeActor;
}): Promise<MutationResult<void>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  const uniqueIds = new Set(params.wormholeIds);
  if (uniqueIds.size !== params.wormholeIds.length) {
    return { ok: false, error: "Wormhole order contains duplicates", status: 400 };
  }

  const reordered = await sql.begin(async (tx): Promise<boolean> => {
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM spaces.wormholes
      WHERE source_space_id = ${params.sourceSpaceId}::uuid
      ORDER BY rank, id
      FOR UPDATE
    `;
    if (rows.length !== params.wormholeIds.length || rows.some((row) => !uniqueIds.has(row.id))) return false;
    for (let index = 0; index < params.wormholeIds.length; index += 1) {
      await tx`
        UPDATE spaces.wormholes
        SET rank = ${rank.toDb(rank.atIndex(index))}::bigint, updated_at = now()
        WHERE id = ${params.wormholeIds[index]}::uuid
      `;
    }
    return true;
  });
  if (!reordered) return { ok: false, error: "Wormhole order must include every configured wormhole", status: 400 };
  await Promise.all(
    params.wormholeIds.map((wormholeId) => publishSpaceEvent({ type: "wormhole.updated", spaceId: params.sourceSpaceId, wormholeId })),
  );
  return { ok: true, data: undefined };
};

export const remove = async (params: { sourceSpaceId: string; id: string; actor: WormholeActor }): Promise<MutationResult<void>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "admin"))) return denied();
  const rows = await sql<{ short_id: string }[]>`
    DELETE FROM spaces.wormholes
    WHERE id = ${params.id}::uuid AND source_space_id = ${params.sourceSpaceId}::uuid
    RETURNING short_id
  `;
  const deleted = rows[0];
  if (!deleted) return { ok: false, error: "Wormhole not found", status: 404 };
  await publishSpaceEvent(
    { type: "wormhole.deleted", spaceId: params.sourceSpaceId, wormholeId: params.id },
    { wormholeId: deleted.short_id },
  );
  return { ok: true, data: undefined };
};

export const transfer = async (params: {
  sourceSpaceId: string;
  itemId: string;
  wormholeId: string;
  actor: WormholeActor;
}): Promise<MutationResult<WormholeTransferResult>> => {
  if (!(await canAccess(params.sourceSpaceId, params.actor, "write"))) return denied();
  const wormhole = await getRow({ sourceSpaceId: params.sourceSpaceId, id: params.wormholeId });
  if (!wormhole) return { ok: false, error: "Wormhole not found", status: 404 };
  if (!(await canAccess(wormhole.target_space_id, params.actor, "write"))) return denied();

  type TransferRow = { id: string; removed_tag_count: number; removed_assignee_count: number; removed_dependency_count: number };
  const transferred = await sql.begin(async (tx): Promise<TransferRow | "recurring" | "changed" | "denied" | "claimed" | null> => {
    const [locked] = await tx<
      {
        id: string;
        target_column_id: string;
        target_space_id: string;
        target_is_done: boolean;
        recurrence_rrule: string | null;
        recurring_event_id: string | null;
      }[]
    >`
      SELECT
        i.id,
        w.target_column_id,
        c.space_id AS target_space_id,
        c.is_done AS target_is_done,
        i.recurrence_rrule,
        i.recurring_event_id
      FROM spaces.items i
      JOIN spaces.wormholes w
        ON w.id = ${params.wormholeId}::uuid
       AND w.source_space_id = ${params.sourceSpaceId}::uuid
      JOIN spaces.columns c ON c.id = w.target_column_id
      WHERE i.id = ${params.itemId}::uuid
        AND i.space_id = ${params.sourceSpaceId}::uuid
      FOR UPDATE OF i, w, c
    `;
    if (!locked) return null;
    const [work] = await tx<{ claim: unknown }[]>`SELECT claim FROM spaces.task_work WHERE item_id = ${params.itemId}::uuid`;
    if (work?.claim) return "claimed";

    if (locked.target_column_id !== wormhole.target_column_id || locked.target_space_id !== wormhole.target_space_id) return "changed";

    // Repeat authorization inside the transfer transaction so a stale page or
    // preflight result cannot authorize the actual cross-space write.
    const principalMatch = buildSpacePrincipalCondition(params.actor.subject);
    const permissions = await tx<{ space_id: string; permission: PermissionLevel }[]>`
      SELECT DISTINCT ON (sa.space_id) sa.space_id, a.permission
      FROM spaces.space_access sa
      JOIN auth.access a ON a.id = sa.access_id
      WHERE sa.space_id IN (${params.sourceSpaceId}::uuid, ${locked.target_space_id}::uuid)
        AND ${principalMatch}
      ORDER BY sa.space_id,
        CASE a.permission
          WHEN 'admin' THEN 4
          WHEN 'write' THEN 3
          WHEN 'read' THEN 2
          ELSE 1
        END DESC
    `;
    const permissionBySpace = new Map(permissions.map((row) => [row.space_id, row.permission]));
    if (
      !hasPermission(permissionBySpace.get(params.sourceSpaceId) ?? "none", "write") ||
      !hasPermission(permissionBySpace.get(locked.target_space_id) ?? "none", "write")
    ) {
      return "denied";
    }
    if (locked.recurrence_rrule || locked.recurring_event_id) return "recurring";

    const [tagCount] = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM spaces.item_tags WHERE item_id = ${params.itemId}::uuid
    `;
    const assigneeRows = await tx<{ user_id: string }[]>`
      SELECT user_id FROM spaces.item_assignees WHERE item_id = ${params.itemId}::uuid
    `;
    const accessRows = await tx<{ access_id: string }[]>`
      SELECT access_id FROM spaces.space_access WHERE space_id = ${locked.target_space_id}::uuid
    `;
    // Existing assignees are concrete authenticated users. A broad target
    // grant therefore preserves all of them without expanding an unbounded
    // public/authenticated principal into an assignable-user list.
    const [broadAccess] = await tx<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM spaces.space_access sa
        JOIN auth.access a ON a.id = sa.access_id
        WHERE sa.space_id = ${locked.target_space_id}::uuid
          AND a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)
          AND (
            a.authenticated_only = true
            OR (
              a.user_id IS NULL
              AND a.group_id IS NULL
              AND a.service_account_id IS NULL
              AND a.authenticated_only = false
            )
          )
      ) AS allowed
    `;
    const validAssigneeIds = broadAccess?.allowed
      ? assigneeRows.map((row) => row.user_id)
      : (
          await listUsersWithAccess({
            accessIds: accessRows.map((row) => row.access_id),
            userIds: assigneeRows.map((row) => row.user_id),
            limit: Math.max(assigneeRows.length, 1),
            db: tx,
          })
        ).map((user) => user.id);

    await tx`DELETE FROM spaces.item_tags WHERE item_id = ${params.itemId}::uuid`;
    const removedAssignees = await tx`
      DELETE FROM spaces.item_assignees
      WHERE item_id = ${params.itemId}::uuid
        AND user_id <> ALL(${toPgUuidArray(validAssigneeIds)}::uuid[])
    `;
    const removedDependencies = await tx`
      DELETE FROM spaces.item_dependencies
      WHERE item_id = ${params.itemId}::uuid
         OR blocker_item_id = ${params.itemId}::uuid
    `;

    const [minRow] = await tx<{ min: string | null }[]>`
      SELECT MIN(rank)::text AS min
      FROM spaces.items
      WHERE column_id = ${locked.target_column_id}::uuid
        AND id <> ${params.itemId}::uuid
    `;
    const targetRank = minRow?.min ? rank.parse(minRow.min) - rank.step() : rank.step();
    const [updated] = await tx<{ id: string }[]>`
      UPDATE spaces.items
      SET space_id = ${locked.target_space_id}::uuid,
          column_id = ${locked.target_column_id}::uuid,
          rank = ${rank.toDb(targetRank)}::bigint,
          completed_at = CASE
            WHEN ${locked.target_is_done} THEN COALESCE(completed_at, now())
            ELSE NULL
          END,
          updated_at = now()
      WHERE id = ${params.itemId}::uuid AND space_id = ${params.sourceSpaceId}::uuid
      RETURNING id
    `;
    if (!updated) return null;
    return {
      id: updated.id,
      removed_tag_count: tagCount?.count ?? 0,
      removed_assignee_count: removedAssignees.count,
      removed_dependency_count: removedDependencies.count,
    };
  });

  if (transferred === "claimed") return { ok: false, error: "Release the task claim before transferring it", status: 409 };
  if (transferred === "changed") return { ok: false, error: "Wormhole destination changed; try again", status: 409 };
  if (transferred === "denied") return denied();
  if (transferred === "recurring") {
    return { ok: false, error: "Recurring items cannot move through wormholes", status: 400 };
  }
  if (!transferred) return { ok: false, error: "Item or wormhole not found", status: 404 };
  const item = await getItem({ id: transferred.id });
  if (!item) return { ok: false, error: "Could not load transferred item", status: 500 };

  await Promise.all([
    publishSpaceEvent({ type: "item.transferred", spaceId: params.sourceSpaceId, itemId: item.id }),
    publishSpaceEvent({ type: "item.transferred", spaceId: wormhole.target_space_id, itemId: item.id }),
  ]);
  return {
    ok: true,
    data: {
      item,
      destination: targetFromRow(wormhole),
      removedTagCount: transferred.removed_tag_count,
      removedAssigneeCount: transferred.removed_assignee_count,
      removedDependencyCount: transferred.removed_dependency_count,
    },
  };
};
