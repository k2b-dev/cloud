import { afterAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { firstOpen } from "./columns";

const suite = databaseSuite();

suite("Spaces default task column", () => {
  const createdSpaces: string[] = [];
  afterAll(async () => {
    for (const id of createdSpaces) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
  });

  /** Creates a Space with `[name, rank, isDone]` columns, inserted in the given order. */
  const createSpace = async (columns: [name: string, rank: number, isDone: boolean][]) => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Default column test') RETURNING id
    `;
    createdSpaces.push(space!.id);
    for (const [name, rank, isDone] of columns) {
      await sql`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${name}, ${rank}, ${isDone})
      `;
    }
    return space!.id;
  };

  test("picks the first column in board order that is not done, whatever the insertion order", async () => {
    const spaceId = await createSpace([
      ["Doing", 3072, false],
      ["Archive", 1024, true],
      ["To do", 2048, false],
    ]);
    expect((await firstOpen({ spaceId }))?.name).toBe("To do");
  });

  test("finds no column in a Space whose columns are all done or that has none", async () => {
    expect(await firstOpen({ spaceId: await createSpace([["Done", 1024, true]]) })).toBeNull();
    expect(await firstOpen({ spaceId: await createSpace([]) })).toBeNull();
  });
});
