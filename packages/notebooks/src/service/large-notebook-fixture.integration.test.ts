import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { type InsertedFixtureNotebook, insertFixtureNotebook, removeFixtureNotebooks } from "./large-notebook.test-fixture";
import { listBacklinks } from "./links";

const postgresTest = testFor("database");
let large: InsertedFixtureNotebook | undefined;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  large = await insertFixtureNotebook("large");
}, 120_000);

afterAll(removeFixtureNotebooks);

postgresTest("the 20,000-page fixture holds its tree, links and tags as the services index them", async () => {
  const notebook = large!;
  const [counts] = await sql<{ notes: number; roots: number; links: number; tags: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM notebooks.notes WHERE notebook_id = ${notebook.id}::uuid) AS notes,
      (SELECT COUNT(*)::int FROM notebooks.notes WHERE notebook_id = ${notebook.id}::uuid AND parent_id IS NULL) AS roots,
      (SELECT COUNT(*)::int FROM notebooks.note_links l JOIN notebooks.notes n ON n.id = l.source_note_id WHERE n.notebook_id = ${notebook.id}::uuid) AS links,
      (SELECT COUNT(*)::int FROM notebooks.note_tags WHERE notebook_id = ${notebook.id}::uuid) AS tags
  `;
  expect(counts).toMatchObject({ notes: 20_000, roots: 40 });
  expect(counts!.links).toBeGreaterThan(20_000);
  expect(counts!.tags).toBeGreaterThan(1_000);
  const [folder] = await sql<
    { children: number }[]
  >`SELECT COUNT(*)::int AS children FROM notebooks.notes WHERE parent_id = ${notebook.folder.id}::uuid`;
  expect(folder!.children).toBe(5000);
  // Links resolve to public IDs the services read back.
  const target = notebook.notes[0]!;
  expect((await listBacklinks({ noteId: target.id, userId: null, bypassAccess: true })).length).toBeGreaterThan(0);
});
