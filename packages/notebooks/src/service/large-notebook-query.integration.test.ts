import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { parseNotebookQueryBlocks } from "../lib/query-blocks";
import { migrate } from "../migrate";
import { loadBookNote } from "./book";
import { type InsertedFixtureNotebook, insertFixtureNotebook, removeFixtureNotebooks } from "./large-notebook.test-fixture";
import { resolveNoteQuery } from "./note-query";

const postgresTest = testFor("database");
let small: InsertedFixtureNotebook | undefined;
let large: InsertedFixtureNotebook | undefined;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  [small, large] = await Promise.all([insertFixtureNotebook("small"), insertFixtureNotebook("large")]);
}, 120_000);

afterAll(async () => {
  await removeFixtureNotebooks();
});

const CHILDREN_QUERY = ":::query\nsource: notes\nscope: children\nsort:\n  field: $title\n  direction: asc\n:::";
const children = parseNotebookQueryBlocks(CHILDREN_QUERY).blocks[0]!;

describe("query blocks in a 20,000-page notebook", () => {
  postgresTest("a folder of 5,000 pages lists 20 at a time, every page reachable, a page past the end shows the last", async () => {
    const notebook = large!;
    const page = (number: number) =>
      resolveNoteQuery({
        notebookId: notebook.id,
        noteId: notebook.folder.id,
        query: children,
        userId: null,
        bypassAccess: true,
        page: { offset: (number - 1) * 20, size: 20 },
      });
    const first = await page(1);
    expect(first).toMatchObject({ total: 5000, limit: 20, offset: 0 });
    expect(first.items).toHaveLength(20);
    const last = await page(250);
    expect(last).toMatchObject({ total: 5000, offset: 4980 });
    expect(last.items).toHaveLength(20);
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(40);
    expect(await page(9999)).toMatchObject({ total: 5000, offset: 4980 });
  });

  postgresTest("a Book page with a children list costs about the same in a 13- and a 20,000-page notebook", async () => {
    const time = async (notebook: InsertedFixtureNotebook) => {
      // The folder lists its pages, as a table of contents for a chapter does.
      await sql`UPDATE notebooks.notes SET content_md = ${`# Folder\n\n${CHILDREN_QUERY}`} WHERE id = ${notebook.folder.id}::uuid`;
      const open = () =>
        loadBookNote({
          notebookId: notebook.id,
          notebookShortId: notebook.shortId,
          noteShortId: notebook.folder.shortId,
          userId: crypto.randomUUID(),
          locale: "en",
          bypassAccess: true,
          pages: new Map(),
        });
      await open();
      const started = performance.now();
      const book = await open();
      return { ms: performance.now() - started, html: book!.document.html };
    };
    const base = await time(small!);
    const big = await time(large!);
    console.info(JSON.stringify({ smallMs: Math.round(base.ms), largeMs: Math.round(big.ms), largeBytes: big.html.length }));
    // One page of 20 rows, whatever the folder holds.
    expect(big.html.match(/<li>/g)?.length ?? 0).toBeLessThanOrEqual(40);
    expect(big.html).toContain("of 5,000");
    expect(big.ms).toBeLessThan(base.ms * 5 + 400);
  });
});
