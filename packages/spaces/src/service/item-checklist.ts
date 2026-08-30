import { sql } from "bun";
import {
  type CreateTaskChecklistEntry,
  MAX_TASK_CHECKLIST_ENTRIES,
  type MutationResult,
  type SpaceTaskChecklistEntry,
  type UpdateTaskChecklistEntry,
} from "@/contracts";
import { withShortId } from "../lib/short-id";
import type { SpaceActivityIdentity } from "./activity";
import * as activity from "./activity";
import { publishSpaceEvent } from "./events";

type ChecklistRow = {
  id: string;
  short_id: string;
  label: string;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
};

type ItemContext = { space_id: string; title: string };

const mapEntry = (row: ChecklistRow): SpaceTaskChecklistEntry => ({
  id: row.short_id,
  label: row.label,
  completed: row.completed,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const getTaskContext = async (itemId: string): Promise<ItemContext | null> => {
  const [item] = await sql<ItemContext[]>`
    SELECT space_id, title
    FROM spaces.items
    WHERE id = ${itemId}
      AND starts_at IS NULL
      AND ends_at IS NULL
  `;
  return item ?? null;
};

const recordChange = async (params: { itemId: string; context: ItemContext; actor: SpaceActivityIdentity; action: string }) => {
  await activity.record({
    spaceId: params.context.space_id,
    itemId: params.itemId,
    actor: params.actor,
    action: params.action,
    metadata: { itemTitle: params.context.title },
  });
};

export const list = async (params: { itemId: string }): Promise<SpaceTaskChecklistEntry[]> => {
  const rows = await sql<ChecklistRow[]>`
    SELECT entry.id, entry.short_id, entry.label, entry.completed, entry.created_at, entry.updated_at
    FROM spaces.item_checklist_entries entry
    JOIN spaces.items item ON item.id = entry.item_id
    WHERE entry.item_id = ${params.itemId}
      AND item.starts_at IS NULL
      AND item.ends_at IS NULL
    ORDER BY entry.rank, entry.id
    LIMIT ${MAX_TASK_CHECKLIST_ENTRIES}
  `;
  return rows.map(mapEntry);
};

export const create = async (params: {
  itemId: string;
  data: CreateTaskChecklistEntry;
  actor: SpaceActivityIdentity;
}): Promise<MutationResult<SpaceTaskChecklistEntry>> => {
  const label = params.data.label.trim();
  const inserted = await withShortId("checklist", (shortId) =>
    sql.begin(async (tx): Promise<MutationResult<{ row: ChecklistRow; context: ItemContext }>> => {
      const [context] = await tx<ItemContext[]>`
        SELECT space_id, title
        FROM spaces.items
        WHERE id = ${params.itemId}
          AND starts_at IS NULL
          AND ends_at IS NULL
        FOR UPDATE
      `;
      if (!context) return { ok: false, error: "Task not found", status: 404 };

      const [count] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM spaces.item_checklist_entries
        WHERE item_id = ${params.itemId}
      `;
      if ((count?.count ?? 0) >= MAX_TASK_CHECKLIST_ENTRIES) {
        return { ok: false, error: "Checklist limit reached", status: 409 };
      }

      const [rank] = await tx<{ value: string }[]>`
        SELECT COALESCE(MAX(rank), 0)::text AS value
        FROM spaces.item_checklist_entries
        WHERE item_id = ${params.itemId}
      `;
      const nextRank = BigInt(rank?.value ?? "0") + 1024n;
      const [row] = await tx<ChecklistRow[]>`
        INSERT INTO spaces.item_checklist_entries (short_id, item_id, label, rank)
        VALUES (${shortId}, ${params.itemId}, ${label}, ${nextRank})
        RETURNING id, short_id, label, completed, created_at, updated_at
      `;
      return row ? { ok: true, data: { row, context } } : { ok: false, error: "Failed to create checklist entry", status: 500 };
    }),
  );
  if (!inserted.ok) return inserted;
  await recordChange({ itemId: params.itemId, context: inserted.data.context, actor: params.actor, action: "checklist.created" });
  await publishSpaceEvent({ type: "item.updated", spaceId: inserted.data.context.space_id, itemId: params.itemId });
  return { ok: true, data: mapEntry(inserted.data.row) };
};

export const update = async (params: {
  itemId: string;
  id: string;
  data: UpdateTaskChecklistEntry;
  actor: SpaceActivityIdentity;
}): Promise<MutationResult<SpaceTaskChecklistEntry>> => {
  const context = await getTaskContext(params.itemId);
  if (!context) return { ok: false, error: "Task not found", status: 404 };
  const label = params.data.label?.trim();
  const [row] = await sql<ChecklistRow[]>`
    UPDATE spaces.item_checklist_entries
    SET label = COALESCE(${label ?? null}, label),
        completed = COALESCE(${params.data.completed ?? null}, completed),
        updated_at = now()
    WHERE id = ${params.id}
      AND item_id = ${params.itemId}
    RETURNING id, short_id, label, completed, created_at, updated_at
  `;
  if (!row) return { ok: false, error: "Checklist entry not found", status: 404 };
  await recordChange({
    itemId: params.itemId,
    context,
    actor: params.actor,
    action:
      params.data.completed === undefined ? "checklist.updated" : params.data.completed ? "checklist.completed" : "checklist.reopened",
  });
  await publishSpaceEvent({ type: "item.updated", spaceId: context.space_id, itemId: params.itemId });
  return { ok: true, data: mapEntry(row) };
};

export const remove = async (params: { itemId: string; id: string; actor: SpaceActivityIdentity }): Promise<MutationResult<void>> => {
  const context = await getTaskContext(params.itemId);
  if (!context) return { ok: false, error: "Task not found", status: 404 };
  const rows = await sql<{ id: string }[]>`
    DELETE FROM spaces.item_checklist_entries
    WHERE id = ${params.id}
      AND item_id = ${params.itemId}
    RETURNING id
  `;
  if (rows.length === 0) return { ok: false, error: "Checklist entry not found", status: 404 };
  await recordChange({ itemId: params.itemId, context, actor: params.actor, action: "checklist.deleted" });
  await publishSpaceEvent({ type: "item.updated", spaceId: context.space_id, itemId: params.itemId });
  return { ok: true, data: undefined };
};
