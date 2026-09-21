import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { setCompleted } from "./items";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

suite("Spaces item completion workflow", () => {
  test("moves items between active and completed workflow columns", async () => {
    const suffix = crypto.randomUUID();
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, description, color)
      VALUES (${newShortId()}, ${`Completion Test ${suffix}`}, 'completion workflow test', '#16a34a')
      RETURNING id
    `;

    try {
      const [activeColumn] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To Do', 1024, false)
        RETURNING id
      `;
      const [doneColumn] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Done', 2048, true)
        RETURNING id
      `;
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${activeColumn!.id}::uuid, 'Ship the workflow', 1024)
        RETURNING id
      `;

      const completed = await setCompleted({ id: item!.id, completed: true });
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error(completed.error);
      expect(completed.data.columnId).toBe(doneColumn!.id);
      expect(completed.data.completedAt).not.toBeNull();

      const completedAgain = await setCompleted({ id: item!.id, completed: true });
      expect(completedAgain.ok).toBe(true);
      if (!completedAgain.ok) throw new Error(completedAgain.error);
      expect(completedAgain.data.columnId).toBe(doneColumn!.id);
      expect(completedAgain.data.rank).toBe(completed.data.rank);

      const reopened = await setCompleted({ id: item!.id, completed: false });
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error(reopened.error);
      expect(reopened.data.columnId).toBe(activeColumn!.id);
      expect(reopened.data.completedAt).toBeNull();
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});
