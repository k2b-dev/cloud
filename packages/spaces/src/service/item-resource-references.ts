import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { MAX_ITEM_RESOURCE_REFERENCES, type SpaceItemResourceReference, type SpaceItemResourceReferenceInput } from "@/contracts";
import { publishSpaceEvent } from "./events";

type ResourceReferenceRow = {
  resource_type: string;
  resource_id: string;
  label: string;
  created_at: Date;
};

export class ItemResourceReferenceLimitError extends Error {}

const mapReference = (row: ResourceReferenceRow): SpaceItemResourceReference => ({
  ref: { type: row.resource_type, id: row.resource_id },
  label: row.label,
  createdAt: row.created_at.toISOString(),
});

const upsertOne = async (
  executor: typeof sql,
  itemId: string,
  reference: SpaceItemResourceReferenceInput,
): Promise<ResourceReferenceRow | null> => {
  const [row] = await executor<ResourceReferenceRow[]>`
    WITH locked_item AS (
      SELECT id
      FROM spaces.items
      WHERE id = ${itemId}::uuid
      FOR UPDATE
    )
    INSERT INTO spaces.item_resource_refs (item_id, resource_type, resource_id, label)
    SELECT locked_item.id, ${reference.ref.type}, ${reference.ref.id}, ${reference.label.trim()}
    FROM locked_item
    WHERE EXISTS (
      SELECT 1
      FROM spaces.item_resource_refs
      WHERE item_id = locked_item.id
        AND resource_type = ${reference.ref.type}
        AND resource_id = ${reference.ref.id}
    ) OR (
      SELECT COUNT(*)
      FROM spaces.item_resource_refs
      WHERE item_id = locked_item.id
    ) < ${MAX_ITEM_RESOURCE_REFERENCES}
    ON CONFLICT (item_id, resource_type, resource_id)
    DO UPDATE SET label = EXCLUDED.label
    RETURNING resource_type, resource_id, label, created_at
  `;
  return row ?? null;
};

export const insertMany = async (executor: typeof sql, itemId: string, references: SpaceItemResourceReferenceInput[]): Promise<void> => {
  for (const reference of references) {
    if (!(await upsertOne(executor, itemId, reference))) throw new ItemResourceReferenceLimitError();
  }
};

export const list = async (params: { itemId: string }): Promise<SpaceItemResourceReference[]> => {
  const rows = await sql<ResourceReferenceRow[]>`
    SELECT resource_type, resource_id, label, created_at
    FROM spaces.item_resource_refs
    WHERE item_id = ${params.itemId}::uuid
    ORDER BY created_at, resource_type, resource_id
  `;
  return rows.map(mapReference);
};

export const findItemIds = async (params: { ref: CloudResourceRef; spaceIds: string[]; limit?: number }): Promise<string[]> => {
  if (params.spaceIds.length === 0) return [];
  const rows = await sql<{ item_id: string }[]>`
    SELECT r.item_id
    FROM spaces.item_resource_refs r
    JOIN spaces.items i ON i.id = r.item_id
    WHERE r.resource_type = ${params.ref.type}
      AND r.resource_id = ${params.ref.id}
      AND i.space_id = ANY(${toPgUuidArray(params.spaceIds)}::uuid[])
    ORDER BY r.created_at DESC, r.item_id
    LIMIT ${params.limit ?? 50}
  `;
  return rows.map((row) => row.item_id);
};

export const add = async (params: {
  itemId: string;
  spaceId: string;
  reference: SpaceItemResourceReferenceInput;
}): Promise<SpaceItemResourceReference | null> => {
  const row = await upsertOne(sql, params.itemId, params.reference);
  if (!row) return null;
  const reference = mapReference(row);
  await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return reference;
};

export const remove = async (params: { itemId: string; spaceId: string; ref: CloudResourceRef }): Promise<boolean> => {
  const result = await sql`
    DELETE FROM spaces.item_resource_refs
    WHERE item_id = ${params.itemId}::uuid
      AND resource_type = ${params.ref.type}
      AND resource_id = ${params.ref.id}
  `;
  const deleted = result.count > 0;
  if (deleted) await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return deleted;
};
