import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { findByTitle } from "./notes";

const postgresTest = testFor("database");

const notebookId = crypto.randomUUID();
const manyId = crypto.randomUUID();
/** Enough notes that every page of matches is full and the exact title lies far beyond it. */
const MANY = 20_000;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'Titles')`;
  const notes: Array<[string, string]> = [
    ["Airplane hangar", ""],
    ["Plan B", ""],
    ["Plan", ""],
    ["Planning", ""],
    ["Budget", "the plan is in the body only"],
    ["100% done", ""],
    ["100 percent", ""],
  ];
  for (const [title, content] of notes) {
    await sql`
      INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
      VALUES (${testShortId()}, ${notebookId}::uuid, ${title}, ${content})
    `;
  }
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${manyId}::uuid, ${testShortId()}, 'Many titles')`;
  await sql`
    INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
    SELECT substr(md5(random()::text || i), 1, 12), ${manyId}::uuid, 'Quarry plan ' || i, ''
    FROM generate_series(1, ${MANY}) AS i
  `;
  await sql`ANALYZE notebooks.notes`;
}, 120_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${manyId}::uuid`;
});

const titles = async (query: string, limit = 50) => (await findByTitle({ notebookId, query, limit })).notes.map((note) => note.title);

describe("finding notes by title", () => {
  postgresTest("the exact title comes first, then titles that start with the text; body text never matches", async () => {
    expect(await titles("plan")).toEqual(["Plan", "Plan B", "Planning", "Airplane hangar"]);
  });

  postgresTest("% and _ are text, not patterns", async () => {
    expect(await titles("100%")).toEqual(["100% done"]);
    expect(await titles("_")).toEqual([]);
  });

  postgresTest("the exact title of one note among thousands of matches is the first offered", async () => {
    const broad = await findByTitle({ notebookId: manyId, query: "quarry", limit: 50 });
    expect(broad.notes).toHaveLength(50);
    expect(broad.hasMore).toBe(true);
    const started = performance.now();
    // "Quarry plan 1999" is also the start of ten longer titles; the shorter exact one comes first.
    const exact = await findByTitle({ notebookId: manyId, query: "quarry plan 1999", limit: 50 });
    const ms = performance.now() - started;
    console.info(JSON.stringify({ notes: MANY, findByTitleMs: Math.round(ms) }));
    expect(exact.notes.map((note) => note.title)).toEqual([
      "Quarry plan 1999",
      ...Array.from({ length: 10 }, (_, i) => `Quarry plan 1999${i}`),
    ]);
    expect(exact.hasMore).toBe(false);
    expect(ms).toBeLessThan(500);
  });
});
