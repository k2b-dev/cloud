import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { type ItemFilter, ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { listFiltered } from "./items";

const suite = databaseSuite();

test("itemIds accepts only public short IDs and at most 100 entries", () => {
  expect(ItemFilterSchema.safeParse({ itemIds: [newShortId()] }).success).toBe(true);
  expect(ItemFilterSchema.safeParse({ itemIds: [crypto.randomUUID()] }).success).toBe(false);
  expect(ItemFilterSchema.safeParse({ itemIds: Array.from({ length: 101 }, () => newShortId()) }).success).toBe(false);
});

suite("Spaces item ID filter", () => {
  test("restricts items and totals by public IDs and intersects the existing column and status filters", async () => {
    const spaces = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name)
      VALUES (${newShortId()}, 'Item filter test'), (${newShortId()}, 'Other filter test') RETURNING id
    `;
    const spaceId = spaces[0]!.id;
    const otherSpaceId = spaces[1]!.id;
    try {
      const columns = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024, false),
               (${newShortId()}, ${spaceId}::uuid, 'Done', 2048, true),
               (${newShortId()}, ${otherSpaceId}::uuid, 'Other', 1024, false) RETURNING id
      `;
      const items = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, completed_at)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'First', NULL),
               (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'Second', NULL),
               (${newShortId()}, ${spaceId}::uuid, ${columns[1]!.id}::uuid, 'Finished', now()),
               (${newShortId()}, ${otherSpaceId}::uuid, ${columns[2]!.id}::uuid, 'Other', NULL)
        RETURNING id, short_id
      `;
      const first = items[0]!;
      const finished = items[2]!;
      const list = (filter: Partial<ItemFilter>) => listFiltered({ spaceId, filter: ItemFilterSchema.parse(filter) });

      expect(await list({ itemIds: [first.short_id], pageSize: 1 })).toMatchObject({
        items: [{ id: first.id }],
        total: 1,
        totalPages: 1,
      });
      const both = await list({ itemIds: [first.short_id, finished.short_id], status: "all", pageSize: 1 });
      expect(both).toMatchObject({ total: 2, totalPages: 2 });
      expect(both.items).toHaveLength(1);
      // Column IDs are already resolved by the transport; itemIds remain public at the service seam.
      const columnMismatch = await listFiltered({
        spaceId,
        filter: { ...ItemFilterSchema.parse({ itemIds: [first.short_id] }), columnIds: [columns[1]!.id] },
      });
      expect(columnMismatch).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [finished.short_id], status: "active" })).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [finished.short_id], status: "completed" })).toMatchObject({ items: [{ id: finished.id }], total: 1 });
      expect(await list({ itemIds: [items[3]!.short_id, newShortId()] })).toMatchObject({ items: [], total: 0 });
      expect(await list({ itemIds: [] })).toMatchObject({ items: [], total: 0 });
      expect(await list({})).toMatchObject({ total: 2 });

      await sql`DELETE FROM spaces.items WHERE id = ${first.id}::uuid`;
      expect(await list({ itemIds: [first.short_id] })).toMatchObject({ items: [], total: 0 });
    } finally {
      for (const space of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${space.id}::uuid`;
    }
  });
});
