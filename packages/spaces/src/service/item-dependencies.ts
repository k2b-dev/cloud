import { sql } from "bun";
import { MAX_ITEM_DEPENDENCIES, type MutationResult, type SpaceTaskDependency, type SpaceTaskDependent } from "@/contracts";
import { publishSpaceEvent } from "./events";

type DependencyRow = {
  blocker_id: string;
  blocker_space_id: string;
  blocker_title: string;
  blocker_completed_at: Date | null;
  created_at: Date;
};

type DependentRow = {
  dependent_id: string;
  dependent_space_id: string;
  dependent_title: string;
  dependent_completed_at: Date | null;
  created_at: Date;
};

const mapDependency = (row: DependencyRow): SpaceTaskDependency => ({
  blocker: {
    id: row.blocker_id,
    spaceId: row.blocker_space_id,
    title: row.blocker_title,
    completedAt: row.blocker_completed_at?.toISOString() ?? null,
  },
  createdAt: row.created_at.toISOString(),
});

const mapDependent = (row: DependentRow): SpaceTaskDependent => ({
  dependent: {
    id: row.dependent_id,
    spaceId: row.dependent_space_id,
    title: row.dependent_title,
    completedAt: row.dependent_completed_at?.toISOString() ?? null,
  },
  createdAt: row.created_at.toISOString(),
});

export const list = async (params: { itemId: string }): Promise<SpaceTaskDependency[]> => {
  const rows = await sql<DependencyRow[]>`
    SELECT
      blocker.id AS blocker_id,
      blocker.space_id AS blocker_space_id,
      blocker.title AS blocker_title,
      blocker.completed_at AS blocker_completed_at,
      dependency.created_at
    FROM spaces.item_dependencies dependency
    JOIN spaces.items blocker ON blocker.id = dependency.blocker_item_id
    WHERE dependency.item_id = ${params.itemId}::uuid
    ORDER BY blocker.completed_at NULLS FIRST, blocker.title, blocker.id
  `;
  return rows.map(mapDependency);
};

export const listBlocks = async (params: { blockerItemId: string }): Promise<SpaceTaskDependent[]> => {
  const rows = await sql<DependentRow[]>`
    SELECT
      dependent.id AS dependent_id,
      dependent.space_id AS dependent_space_id,
      dependent.title AS dependent_title,
      dependent.completed_at AS dependent_completed_at,
      dependency.created_at
    FROM spaces.item_dependencies dependency
    JOIN spaces.items dependent ON dependent.id = dependency.item_id
    WHERE dependency.blocker_item_id = ${params.blockerItemId}::uuid
    ORDER BY dependent.completed_at NULLS FIRST, dependent.title, dependent.id
  `;
  return rows.map(mapDependent);
};

export const add = async (params: {
  itemId: string;
  blockerItemId: string;
  spaceId: string;
}): Promise<MutationResult<SpaceTaskDependency>> => {
  if (params.itemId === params.blockerItemId) {
    return { ok: false, error: "A task cannot block itself", status: 400 };
  }

  const result = await sql.begin(async (tx): Promise<MutationResult<DependencyRow>> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('spaces.item-dependencies'), hashtext(${params.spaceId}))`;
    const items = await tx<{ id: string; space_id: string; starts_at: Date | null; ends_at: Date | null; completed_at: Date | null }[]>`
      SELECT id, space_id, starts_at, ends_at, completed_at
      FROM spaces.items
      WHERE id IN (${params.itemId}::uuid, ${params.blockerItemId}::uuid)
      ORDER BY id
      FOR UPDATE
    `;
    const item = items.find((candidate) => candidate.id === params.itemId);
    const blocker = items.find((candidate) => candidate.id === params.blockerItemId);
    if (!item || !blocker || item.space_id !== params.spaceId || blocker.space_id !== params.spaceId) {
      return { ok: false, error: "Blocker task not found in space", status: 404 };
    }
    if (item.starts_at || item.ends_at || blocker.starts_at || blocker.ends_at) {
      return { ok: false, error: "Task dependencies can only connect tasks", status: 400 };
    }
    if (item.completed_at && !blocker.completed_at) {
      return { ok: false, error: "A completed task cannot gain an active blocker", status: 409 };
    }

    const [count] = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM spaces.item_dependencies
      WHERE item_id = ${params.itemId}::uuid
    `;
    if ((count?.count ?? 0) >= MAX_ITEM_DEPENDENCIES) {
      return { ok: false, error: `A task can have at most ${MAX_ITEM_DEPENDENCIES} blockers`, status: 409 };
    }

    const [cycle] = await tx<{ found: boolean }[]>`
      WITH RECURSIVE dependency_path(blocker_item_id) AS (
        SELECT blocker_item_id
        FROM spaces.item_dependencies
        WHERE item_id = ${params.blockerItemId}::uuid
        UNION
        SELECT dependency.blocker_item_id
        FROM spaces.item_dependencies dependency
        JOIN dependency_path path ON dependency.item_id = path.blocker_item_id
      )
      SELECT EXISTS (
        SELECT 1 FROM dependency_path WHERE blocker_item_id = ${params.itemId}::uuid
      ) AS found
    `;
    if (cycle?.found) return { ok: false, error: "Task dependency would create a cycle", status: 409 };

    const [created] = await tx<DependencyRow[]>`
      WITH inserted AS (
        INSERT INTO spaces.item_dependencies (item_id, blocker_item_id)
        VALUES (${params.itemId}::uuid, ${params.blockerItemId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING blocker_item_id, created_at
      )
      SELECT
        blocker.id AS blocker_id,
        blocker.space_id AS blocker_space_id,
        blocker.title AS blocker_title,
        blocker.completed_at AS blocker_completed_at,
        inserted.created_at
      FROM inserted
      JOIN spaces.items blocker ON blocker.id = inserted.blocker_item_id
    `;
    return created ? { ok: true, data: created } : { ok: false, error: "Task dependency already exists", status: 409 };
  });

  if (!result.ok) return result;
  await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return { ok: true, data: mapDependency(result.data) };
};

export const remove = async (params: { itemId: string; blockerItemId: string; spaceId: string }): Promise<MutationResult<void>> => {
  const result = await sql`
    DELETE FROM spaces.item_dependencies dependency
    USING spaces.items item, spaces.items blocker
    WHERE dependency.item_id = item.id
      AND dependency.blocker_item_id = blocker.id
      AND item.id = ${params.itemId}::uuid
      AND blocker.id = ${params.blockerItemId}::uuid
      AND item.space_id = ${params.spaceId}::uuid
      AND blocker.space_id = ${params.spaceId}::uuid
  `;
  if (result.count === 0) return { ok: false, error: "Task dependency not found", status: 404 };
  await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return { ok: true, data: undefined };
};
