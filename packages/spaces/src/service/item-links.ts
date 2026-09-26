import { sql } from "bun";
import { MAX_ITEM_LINKS, type SpaceItemLinkInput } from "@/contracts";
import { publishSpaceEvent } from "./events";

type LinkRow = { url: string; label: string | null; created_at: Date };

/** A stored external link before previews are attached. */
export type StoredItemLink = { url: string; label: string | null; createdAt: string };

const mapLink = (row: LinkRow): StoredItemLink => ({ url: row.url, label: row.label, createdAt: row.created_at.toISOString() });

const normalize = (input: SpaceItemLinkInput) => ({ url: input.url.trim(), label: input.label?.trim() || null });

export const list = async (params: { itemId: string }): Promise<StoredItemLink[]> => {
  const rows = await sql<LinkRow[]>`
    SELECT url, label, created_at
    FROM spaces.item_links
    WHERE item_id = ${params.itemId}::uuid
    ORDER BY created_at, url
  `;
  return rows.map(mapLink);
};

/** Upserts one link; returns null when the item already holds `MAX_ITEM_LINKS` other links. */
export const add = async (params: { itemId: string; spaceId: string; link: SpaceItemLinkInput }): Promise<StoredItemLink | null> => {
  const link = normalize(params.link);
  const [row] = await sql<LinkRow[]>`
    WITH locked_item AS (
      SELECT id FROM spaces.items WHERE id = ${params.itemId}::uuid FOR UPDATE
    )
    INSERT INTO spaces.item_links (item_id, url, label)
    SELECT locked_item.id, ${link.url}, ${link.label}
    FROM locked_item
    WHERE EXISTS (SELECT 1 FROM spaces.item_links WHERE item_id = locked_item.id AND url = ${link.url})
      OR (SELECT COUNT(*) FROM spaces.item_links WHERE item_id = locked_item.id) < ${MAX_ITEM_LINKS}
    ON CONFLICT (item_id, url) DO UPDATE SET label = EXCLUDED.label
    RETURNING url, label, created_at
  `;
  if (!row) return null;
  await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return mapLink(row);
};

export const remove = async (params: { itemId: string; spaceId: string; url: string }): Promise<boolean> => {
  const result = await sql`
    DELETE FROM spaces.item_links WHERE item_id = ${params.itemId}::uuid AND url = ${params.url.trim()}
  `;
  const deleted = result.count > 0;
  if (deleted) await publishSpaceEvent({ type: "item.updated", spaceId: params.spaceId, itemId: params.itemId });
  return deleted;
};
