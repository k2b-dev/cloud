import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { ItemFilterSchema } from "@/contracts";
import { newShortId } from "../lib/short-id";
import * as activity from "./activity";
import { listFiltered } from "./items";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ items: string | null; activity: string | null }[]>`
      SELECT to_regclass('spaces.items')::text AS items, to_regclass('spaces.activity_events')::text AS activity
    `;
    return Boolean(row?.items && row.activity);
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("Spaces inactive task filtering", () => {
  test("includes only open tasks whose latest real activity is older than 30 days", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Inactive ${crypto.randomUUID()}`}, '#6366f1')
      RETURNING id
    `;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To do', 1024)
        RETURNING id
      `;
      const [stale, fresh, event] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank, starts_at, ends_at, updated_at)
        VALUES
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Stale task', 1024, NULL, NULL, now() - interval '31 days'),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Fresh task', 2048, NULL, NULL, now()),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Old event', 3072, now() - interval '31 days', now() - interval '30 days 23 hours', now() - interval '31 days')
        RETURNING id
      `;
      const filter = ItemFilterSchema.parse({ activity: "inactive", groupBy: "none" });
      const initial = await listFiltered({ spaceId: space!.id, filter });
      expect(initial.items.map((item) => item.title)).toEqual(["Stale task"]);

      await activity.record({
        spaceId: space!.id,
        itemId: stale!.id,
        actor: { kind: "system", id: null },
        action: "comment.created",
      });
      const refreshed = await listFiltered({ spaceId: space!.id, filter });
      expect(refreshed.items).toHaveLength(0);
      expect(fresh).toBeDefined();
      expect(event).toBeDefined();
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});
