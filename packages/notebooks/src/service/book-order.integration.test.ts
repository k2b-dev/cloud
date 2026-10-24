import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { type InsertedFixtureNotebook, insertFixtureNotebook } from "./large-notebook.test-fixture";
import { loadBookNavigation } from "./sidebar-tree";
import { readLevel, revealNote } from "./tree-levels";

const postgresTest = testFor("database");
const notebookId = crypto.randomUUID();
const ids = {
  k10: crypto.randomUUID(),
  k2: crypto.randomUUID(),
  over: crypto.randomUUID(),
  flow: crypto.randomUUID(),
  hello: crypto.randomUUID(),
  solo: crypto.randomUUID(),
  start: crypto.randomUUID(),
};
let large: InsertedFixtureNotebook | undefined;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'Book order')`;
  for (const [id, parent, title] of [
    [ids.k10, null, "Kapitel 10"],
    [ids.k2, null, "Kapitel 2"],
    [ids.over, ids.k2, "Überblick"],
    [ids.flow, ids.k2, "Ablauf"],
    [ids.hello, null, "Willkommen"],
    [ids.solo, null, "Anhang"],
    [ids.start, ids.solo, "Start"],
  ] as const)
    await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, parent_id, title) VALUES
      (${id}::uuid, ${testShortId()}, ${notebookId}::uuid, ${parent}::uuid, ${title})`;
  large = await insertFixtureNotebook("large");
}, 120_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
  await large?.remove();
});

const titles = async (parentId: string | null, homepageId: string | null) =>
  (await readLevel({ notebookId, parentId, sort: "title", locale: "de", homepageId, book: true })).map((entry) => entry.title);

postgresTest("Book reads the start page first, also from below another page, and lists it once", async () => {
  expect(await titles(null, null)).toEqual(["Anhang", "Kapitel 2", "Kapitel 10", "Willkommen"]);
  expect(await titles(null, ids.hello)).toEqual(["Willkommen", "Anhang", "Kapitel 2", "Kapitel 10"]);
  expect(await titles(null, ids.over)).toEqual(["Überblick", "Anhang", "Kapitel 2", "Kapitel 10", "Willkommen"]);
  expect(await titles(ids.k2, ids.over)).toEqual(["Ablauf"]);
  // A page below the start page opens on the way down from the top level, where the start page now stands.
  const way = await revealNote({ notebookId, noteId: ids.over, sort: "title", locale: "de", homepageId: ids.over, book: true });
  expect(way.expandedIds).toEqual([]);
  // The page a start page left keeps a disclosure only while it has other sub-pages.
  const root = await readLevel({ notebookId, parentId: null, sort: "title", locale: "de", homepageId: ids.start, book: true });
  expect(root.map((entry) => [entry.title, entry.hasChildren])).toEqual([
    ["Start", false],
    ["Anhang", false],
    ["Kapitel 2", true],
    ["Kapitel 10", false],
    ["Willkommen", false],
  ]);
});

postgresTest("Book's navigation of a 20,000-page notebook is a few windows, not the tree", async () => {
  const notebook = large!;
  const navigation = await loadBookNavigation({
    notebookId: notebook.id,
    homepageId: null,
    locale: "en",
    selectedNoteId: notebook.page.id,
  });
  expect(navigation.total).toBe(20_000);
  expect(navigation.levels.reduce((sum, level) => sum + level.items.length, 0)).toBeLessThan(1000);
  expect(navigation.levels.some((level) => level.items.some((item) => item.id === notebook.page.shortId))).toBe(true);
});
