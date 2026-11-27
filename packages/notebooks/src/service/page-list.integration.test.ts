import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { listPages, type PageListSort } from "./page-list";

// The notes list against real Postgres: each filter, the search, the count and each order, and every page costs two
// statements (the page and its count), whatever the filter.
const suite = databaseSuite();
suite("the notes list's pages", () => {
  const notebookId = crypto.randomUUID();
  const other = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const day = (n: number) => new Date(Date.UTC(2026, 10, n, 9));
  // title, created, updated, tags, favorite of the person, text
  const notes: [string, number, number, string[], boolean, string][] = [
    ["Beta", 1, 9, ["lager"], true, "Regal 4B prüfen"],
    ["alpha", 2, 3, ["lager", "team"], false, "Schlüssel verteilen"],
    ["Gamma", 3, 5, [], true, "Messe Leipzig"],
    ["Delta", 4, 4, ["team"], false, "Stand 4B aufbauen"],
  ];

  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile)
      VALUES (${userId}::uuid, ${`page-list-${userId}`}, 'Ada Renz', 'local', 'user')`;
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'List')`;
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${other}::uuid, ${testShortId()}, 'Other')`;
    for (const [title, created, updated, tags, favorite, text] of notes) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md, created_at, updated_at)
        VALUES (${testShortId()}, ${notebookId}::uuid, ${title}, ${text}, ${day(created)}, ${day(updated)})
        RETURNING id`;
      for (const tag of tags)
        await sql`INSERT INTO notebooks.note_tags (note_id, notebook_id, tag) VALUES (${row!.id}::uuid, ${notebookId}::uuid, ${tag})`;
      if (favorite)
        await sql`INSERT INTO notebooks.note_favorites (user_id, notebook_id, note_id)
          VALUES (${userId}::uuid, ${notebookId}::uuid, ${row!.id}::uuid)`;
    }
    // another notebook's note with the same tag and text stays out of every list
    const [stray] = await sql<{ id: string }[]>`
      INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md, created_at, updated_at)
      VALUES (${testShortId()}, ${other}::uuid, 'Stray', 'Regal 4B', ${day(9)}, ${day(9)})
      RETURNING id`;
    await sql`INSERT INTO notebooks.note_tags (note_id, notebook_id, tag) VALUES (${stray!.id}::uuid, ${other}::uuid, 'lager')`;
  });
  afterAll(async () => {
    await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${other}::uuid)`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const list = (options: { favorite?: boolean; tag?: string; search?: string; sort?: PageListSort; offset?: number; limit?: number }) =>
    listPages({
      notebookId,
      userId,
      favorite: options.favorite,
      tag: options.tag ?? null,
      search: options.search ?? null,
      sort: options.sort ?? "title",
      offset: options.offset ?? 0,
      limit: options.limit ?? 50,
    });
  const titles = (page: Awaited<ReturnType<typeof listPages>>) => page.items.map((item) => item.title);

  test("each filter and the search narrow the notebook's notes, and the count follows them", async () => {
    expect(await list({})).toMatchObject({ total: 4 });
    expect(titles(await list({}))).toEqual(["alpha", "Beta", "Delta", "Gamma"]);

    const favorites = await list({ favorite: true });
    expect([titles(favorites), favorites.total]).toEqual([["Beta", "Gamma"], 2]);
    const others = await list({ favorite: false });
    expect([titles(others), others.total]).toEqual([["alpha", "Delta"], 2]);

    // a tag matches whatever case the address writes it in
    const tagged = await list({ tag: "Lager" });
    expect([titles(tagged), tagged.total]).toEqual([["alpha", "Beta"], 2]);
    expect(tagged.items.find((item) => item.title === "alpha")?.tags).toEqual(["lager", "team"]);

    // the search reads titles and text, case-insensitive
    const found = await list({ search: " 4b " });
    expect([titles(found), found.total]).toEqual([["Beta", "Delta"], 2]);
    expect(titles(await list({ search: "ALPHA" }))).toEqual(["alpha"]);

    // filters combine
    const combined = await list({ favorite: true, tag: "lager", search: "regal" });
    expect([titles(combined), combined.total]).toEqual([["Beta"], 1]);
    expect(await list({ favorite: false, tag: "team", search: "messe" })).toEqual({ items: [], total: 0 });
  });

  test("each order sorts the whole list, and a page counts all matches", async () => {
    expect(titles(await list({ sort: "updated" }))).toEqual(["Beta", "Gamma", "Delta", "alpha"]);
    expect(titles(await list({ sort: "created" }))).toEqual(["Delta", "Gamma", "alpha", "Beta"]);
    expect(titles(await list({ sort: "title" }))).toEqual(["alpha", "Beta", "Delta", "Gamma"]);

    const second = await list({ sort: "updated", offset: 2, limit: 2 });
    expect([titles(second), second.total]).toEqual([["Delta", "alpha"], 4]);
    expect(await list({ offset: 4, limit: 2 })).toEqual({ items: [], total: 4 });
  });

  test("a page is two statements, the page and its count, whatever the filter", async () => {
    const meter = await meterSql();
    try {
      for (const options of [{}, { favorite: true }, { favorite: false, tag: "team" }, { search: "4b", sort: "created" as const }]) {
        const statements = await meter.during(() => list(options));
        expect(statements).toHaveLength(2);
      }
    } finally {
      await meter.close();
    }
  });
});
