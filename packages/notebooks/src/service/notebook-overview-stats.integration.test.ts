import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { overviewStats } from "./notebooks";

const postgresTest = testFor("database");
const first = crypto.randomUUID();
const second = crypto.randomUUID();
const empty = crypto.randomUUID();

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`
    INSERT INTO notebooks.notebooks (id, name)
    VALUES (${first}::uuid, 'Overview stats first'), (${second}::uuid, 'Overview stats second'), (${empty}::uuid, 'Overview stats empty')
  `;
  await sql`
    INSERT INTO notebooks.notes (id, notebook_id, title, updated_at)
    VALUES
      (${crypto.randomUUID()}::uuid, ${first}::uuid, 'One', '2026-01-01T10:00:00Z'),
      (${crypto.randomUUID()}::uuid, ${first}::uuid, 'Two', '2026-02-01T10:00:00Z'),
      (${crypto.randomUUID()}::uuid, ${second}::uuid, 'Three', '2026-03-01T10:00:00Z')
  `;
});

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(ARRAY[${first}::uuid, ${second}::uuid, ${empty}::uuid])`;
});

// The overview page passes every listed notebook at once; the regression was a
// JS array bound as a comma-joined string, which Postgres rejects as a
// malformed array literal as soon as there are two notebooks.
postgresTest("computes overview counts for several notebooks in one query", async () => {
  const stats = await overviewStats({ notebookIds: [first, second, empty] });
  const byId = new Map(stats.map((item) => [item.notebookId, item]));
  expect(byId.size).toBe(3);
  expect(byId.get(first)).toMatchObject({ noteCount: 2, lastNoteAt: "2026-02-01T10:00:00.000Z" });
  expect(byId.get(second)).toMatchObject({ noteCount: 1, lastNoteAt: "2026-03-01T10:00:00.000Z" });
  expect(byId.get(empty)).toMatchObject({ noteCount: 0, lastNoteAt: null });
  expect(await overviewStats({ notebookIds: [] })).toEqual([]);
});
