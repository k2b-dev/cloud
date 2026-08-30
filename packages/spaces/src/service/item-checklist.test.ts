import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import * as checklist from "./item-checklist";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ checklist: string | null }[]>`
      SELECT to_regclass('spaces.item_checklist_entries')::text AS checklist
    `;
    return Boolean(row?.checklist);
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;
const actor = { kind: "system" as const, id: null };

suite("Spaces task checklist", () => {
  test("keeps bounded entries ordered and supports label, completion, and deletion changes", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Checklist ${crypto.randomUUID()}`}, '#6366f1')
      RETURNING id
    `;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To do', 1024)
        RETURNING id
      `;
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Prepare release', 1024)
        RETURNING id
      `;
      const [event] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank, starts_at, ends_at)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Release call', 2048, now(), now() + interval '1 hour')
        RETURNING id
      `;

      const first = await checklist.create({ itemId: task!.id, data: { label: "Write notes" }, actor });
      const second = await checklist.create({ itemId: task!.id, data: { label: "Publish" }, actor });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect((await checklist.list({ itemId: task!.id })).map((entry) => entry.label)).toEqual(["Write notes", "Publish"]);

      if (!first.ok) return;
      const [internal] = await sql<{ id: string }[]>`
        SELECT id FROM spaces.item_checklist_entries WHERE short_id = ${first.data.id}
      `;
      const updated = await checklist.update({
        itemId: task!.id,
        id: internal!.id,
        data: { label: "Write release notes", completed: true },
        actor,
      });
      expect(updated.ok && updated.data).toMatchObject({ label: "Write release notes", completed: true });
      expect((await checklist.remove({ itemId: task!.id, id: internal!.id, actor })).ok).toBe(true);
      expect((await checklist.list({ itemId: task!.id })).map((entry) => entry.label)).toEqual(["Publish"]);

      const eventEntry = await checklist.create({ itemId: event!.id, data: { label: "Invalid" }, actor });
      expect(eventEntry.ok).toBe(false);
      if (!eventEntry.ok) expect(eventEntry.status).toBe(404);

      const [activity] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM spaces.activity_events WHERE item_id = ${task!.id} AND action LIKE 'checklist.%'
      `;
      expect(activity?.count).toBe(4);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});
