import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { get, update } from "./items";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ items: string | null }[]>`SELECT to_regclass('spaces.items')::text AS items`;
    return Boolean(row?.items);
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;

suite("Spaces item updates", () => {
  test("preserves unrelated fields across concurrent partial updates", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Concurrent updates ${crypto.randomUUID()}`}, '#2563eb')
      RETURNING id
    `;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}, 'To Do', 1024, false)
        RETURNING id
      `;
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}, ${column!.id}, 'Original', 1024)
        RETURNING id
      `;

      for (let index = 0; index < 8; index += 1) {
        const title = `Title ${index}`;
        const priority = index % 2 === 0 ? "high" : "low";
        const [titleResult, priorityResult] = await Promise.all([
          update({ id: item!.id, data: { title } }),
          update({ id: item!.id, data: { priority } }),
        ]);
        expect(titleResult.ok).toBe(true);
        expect(priorityResult.ok).toBe(true);
        expect(await get({ id: item!.id })).toMatchObject({ title, priority });
      }
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}`;
    }
  });

  test("rolls back the item when its activity record fails", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Atomic activity ${crypto.randomUUID()}`}, '#16a34a')
      RETURNING id
    `;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}, 'To Do', 1024, false)
        RETURNING id
      `;
      const [item] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}, ${column!.id}, 'Keep me', 1024)
        RETURNING id
      `;

      await expect(
        update({ id: item!.id, data: { title: "Must roll back" }, actor: { kind: "system", id: crypto.randomUUID() } }),
      ).rejects.toThrow("Invalid Spaces activity actor");
      expect(await get({ id: item!.id })).toMatchObject({ title: "Keep me" });
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}`;
    }
  });
});
