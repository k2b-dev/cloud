import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { resetSearchBackend, searchAcross, searchInNotebook } from "./search";

const postgresTest = testFor("database");
const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const notebookId = crypto.randomUUID();
const accessId = crypto.randomUUID();
const notes = [
  { title: "Meetings", content: "Unsere Besprechungen finden am Montag statt." },
  { title: "Overview", content: "Ein Überblick über die Aufgaben." },
  { title: "Summary", content: "Der überblick bleibt aktuell." },
  { title: "Woche 41", content: "Kurze Notiz." },
  { title: "Woche 41 Notizen", content: "Weitere Notizen." },
  { title: "Weekly archive", content: "Woche 41 ".repeat(100) },
  { title: "Adjacent", content: "We planned the deployment rollback yesterday." },
  { title: "Apart", content: "The deployment succeeded. Later we needed a rollback." },
  { title: "Single", content: "The deployment succeeded." },
  { title: "Alphabet", content: "Alpha begins here." },
];

const search = (query: string) => searchInNotebook({ notebookId, filters: { query }, pagination: { page: 1, perPage: 20, offset: 0 } });

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  resetSearchBackend();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${shortId()}, 'Search tests')`;
    // A public read grant lets the cross-notebook search run without a user fixture.
    await tx`INSERT INTO auth.access (id, permission) VALUES (${accessId}::uuid, 'read')`;
    await tx`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${accessId}::uuid)`;
    for (const note of notes) {
      await tx`
        INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
        VALUES (${shortId()}, ${notebookId}::uuid, ${note.title}, ${note.content})
      `;
    }
  });
}, 30_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
  await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
});

describe("notebook word-start search and title ranking", () => {
  postgresTest("finds a body word start and highlights the whole word", async () => {
    const result = await search("Bespr");
    expect(result.hits.map((hit) => hit.note.title)).toEqual(["Meetings"]);
    expect(result.total).toBe(1);
    expect(result.hits[0]?.snippet).toContain("\uE000Besprechungen\uE001");
  });

  for (const query of ["Über", "über"]) {
    postgresTest(`finds Unicode word starts for ${query}`, async () => {
      const result = await search(query);
      expect(result.hits.map((hit) => hit.note.title).sort()).toEqual(["Overview", "Summary"]);
      expect(result.total).toBe(2);
    });
  }

  postgresTest("ranks exact titles before title prefixes and repeated body matches", async () => {
    const oldRanking = await sql<{ title: string; rank: number }[]>`
      SELECT title, ts_rank_cd(search_document, websearch_to_tsquery('simple', 'Woche 41')) AS rank
      FROM notebooks.notes
      WHERE notebook_id = ${notebookId}::uuid
        AND search_document @@ websearch_to_tsquery('simple', 'Woche 41')
      ORDER BY rank DESC, updated_at DESC, id ASC
    `;
    expect(oldRanking[0]?.title).toBe("Weekly archive");
    expect(oldRanking[0]!.rank).toBeGreaterThan(oldRanking.find((note) => note.title === "Woche 41")!.rank);

    for (const query of ["Woche 41", "woche 41"]) {
      const result = await search(query);
      expect(result.hits.map((hit) => hit.note.title)).toEqual(["Woche 41", "Woche 41 Notizen", "Weekly archive"]);
      expect(result.total).toBe(3);
    }
  });

  for (const query of ["a:*", "(", "!", "&|", "", '""', '"']) {
    postgresTest(`accepts punctuation or empty query ${JSON.stringify(query)}`, async () => {
      const result = await search(query);
      expect(typeof result.total).toBe("number");
      expect(result.total).toBe(result.hits.length);
      if (query === "a:*") expect(result.hits.map((hit) => hit.note.title)).toContain("Alphabet");
      if (query === "") expect(result.total).toBe(notes.length);
    });
  }

  postgresTest("cross-notebook search shares word starts and title ranking", async () => {
    const across = (query: string) =>
      searchAcross({ userId: null, notebookId, filters: { query }, pagination: { page: 1, perPage: 20, offset: 0 } });
    const words = await across("Bespr");
    expect(words.hits.map((hit) => hit.note.title)).toEqual(["Meetings"]);
    expect(words.total).toBe(1);
    const titles = await across("Woche 41");
    expect(titles.hits.map((hit) => hit.note.title)).toEqual(["Woche 41", "Woche 41 Notizen", "Weekly archive"]);
    expect(titles.total).toBe(3);
  });

  postgresTest("preserves multi-word and phrase match sets", async () => {
    const words = await search("deployment rollback");
    expect(words.hits.map((hit) => hit.note.title).sort()).toEqual(["Adjacent", "Apart"]);
    expect(words.total).toBe(2);
    expect(words.total).toBe(words.hits.length);

    const phrase = await search('"deployment rollback"');
    expect(phrase.hits.map((hit) => hit.note.title)).toEqual(["Adjacent"]);
    expect(phrase.total).toBe(1);
    expect(phrase.total).toBe(phrase.hits.length);
  });
});
