import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import * as dependencies from "./item-dependencies";
import { get as getItem, setCompleted } from "./items";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ dependencies: string | null }[]>`
      SELECT to_regclass('spaces.item_dependencies')::text AS dependencies
    `;
    return Boolean(row?.dependencies);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the migrated backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("Spaces task dependencies", () => {
  test("supports multiple blockers and rejects duplicates, cycles, events, and cross-space links", async () => {
    const suffix = crypto.randomUUID();
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Dependencies ${suffix}`}, '#6366f1')
      RETURNING id
    `;
    const [otherSpace] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Other ${suffix}`}, '#0ea5e9')
      RETURNING id
    `;

    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To do', 1024)
        RETURNING id
      `;
      const [otherColumn] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${otherSpace!.id}::uuid, 'To do', 1024)
        RETURNING id
      `;
      const rows = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank, starts_at, ends_at)
        VALUES
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Target', 1024, NULL, NULL),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'First blocker', 2048, NULL, NULL),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Second blocker', 3072, NULL, NULL),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Event', 4096, now(), now() + interval '1 hour')
        RETURNING id
      `;
      const [otherTask] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${otherSpace!.id}::uuid, ${otherColumn!.id}::uuid, 'Other task', 1024)
        RETURNING id
      `;
      const [target, first, second, event] = rows;

      expect((await dependencies.add({ itemId: target!.id, blockerItemId: first!.id, spaceId: space!.id })).ok).toBe(true);
      expect((await dependencies.add({ itemId: target!.id, blockerItemId: second!.id, spaceId: space!.id })).ok).toBe(true);
      expect((await dependencies.list({ itemId: target!.id })).map((dependency) => dependency.blocker.title)).toEqual([
        "First blocker",
        "Second blocker",
      ]);
      expect((await dependencies.listBlocks({ blockerItemId: first!.id })).map((dependency) => dependency.dependent.title)).toEqual([
        "Target",
      ]);
      expect((await getItem({ id: target!.id }))?.activeBlockerCount).toBe(2);

      const duplicate = await dependencies.add({ itemId: target!.id, blockerItemId: first!.id, spaceId: space!.id });
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.status).toBe(409);

      const cycle = await dependencies.add({ itemId: first!.id, blockerItemId: target!.id, spaceId: space!.id });
      expect(cycle.ok).toBe(false);
      if (!cycle.ok) expect(cycle.status).toBe(409);

      const eventLink = await dependencies.add({ itemId: target!.id, blockerItemId: event!.id, spaceId: space!.id });
      expect(eventLink.ok).toBe(false);
      if (!eventLink.ok) expect(eventLink.status).toBe(400);

      const crossSpace = await dependencies.add({ itemId: target!.id, blockerItemId: otherTask!.id, spaceId: space!.id });
      expect(crossSpace.ok).toBe(false);
      if (!crossSpace.ok) expect(crossSpace.status).toBe(404);

      expect((await dependencies.remove({ itemId: target!.id, blockerItemId: first!.id, spaceId: space!.id })).ok).toBe(true);
      expect((await dependencies.list({ itemId: target!.id })).map((dependency) => dependency.blocker.id)).toEqual([second!.id]);

      const blockedCompletion = await setCompleted({ id: target!.id, completed: true });
      expect(blockedCompletion.ok).toBe(false);
      if (!blockedCompletion.ok) expect(blockedCompletion.status).toBe(409);

      expect((await setCompleted({ id: second!.id, completed: true })).ok).toBe(true);
      expect((await getItem({ id: target!.id }))?.activeBlockerCount).toBe(0);
      expect((await setCompleted({ id: target!.id, completed: true })).ok).toBe(true);
      expect((await setCompleted({ id: first!.id, completed: false })).ok).toBe(true);
      const completedTarget = await dependencies.add({ itemId: target!.id, blockerItemId: first!.id, spaceId: space!.id });
      expect(completedTarget.ok).toBe(false);
      if (!completedTarget.ok) expect(completedTarget.status).toBe(409);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id IN (${space!.id}::uuid, ${otherSpace!.id}::uuid)`;
    }
  });
});
