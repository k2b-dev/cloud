import { sql } from "bun";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { buildFixtureTree, type FixtureShape, renderFixtureMarkdown } from "../../scripts/large-notebook-fixture";
import { deriveNoteTitle } from "../lib/note-title";

export type InsertedFixtureNotebook = {
  id: string;
  shortId: string;
  /** Internal and public IDs in fixture order. */
  notes: Array<{ id: string; shortId: string; parentId: string | null; title: string }>;
  /** The folder with the most direct children, a page inside it and its first page. */
  folder: { id: string; shortId: string };
  page: { id: string; shortId: string };
  other: { id: string; shortId: string };
  remove: () => Promise<void>;
};

const BATCH = 2000;
/** Every notebook this process inserted, so a suite removes them even when its setup timed out halfway. */
const inserted = new Set<string>();
const base = Date.parse("2026-09-01T08:00:00.000Z");

/**
 * Inserts one fixture notebook of the shape straight into the test database:
 * notes with their Markdown, links and tags, as the services index them. The
 * services' own write paths are covered elsewhere; this only builds the state
 * a 20,000-page notebook leaves behind, in a few seconds.
 */
export async function insertFixtureNotebook(shape: FixtureShape): Promise<InsertedFixtureNotebook> {
  const tree = buildFixtureTree(shape);
  const notebook = { id: crypto.randomUUID(), shortId: testShortId() };
  const notes = tree.map((note) => ({ id: crypto.randomUUID(), shortId: testShortId(), parentIndex: note.parent }));
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebook.id}::uuid, ${notebook.shortId}, ${`Fixture ${shape}`})`;
  inserted.add(notebook.id);
  const rows = tree.map((note, index) => {
    const contentMd = renderFixtureMarkdown(note, { shortIdOf: (target) => notes[target]?.shortId });
    // Spread the dates so every order by date has a stable answer.
    const at = new Date(base + index * 60_000).toISOString();
    return {
      id: notes[index]!.id,
      shortId: notes[index]!.shortId,
      parentId: note.parent === null ? null : notes[note.parent]!.id,
      title: deriveNoteTitle(contentMd),
      contentMd,
      at,
    };
  });
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    await sql`
      INSERT INTO notebooks.notes (id, short_id, notebook_id, parent_id, title, content_md, created_at, updated_at)
      SELECT id, short_id, ${notebook.id}::uuid, parent_id, title, content_md, at, at
      FROM unnest(
        ${sql.array(
          batch.map((row) => row.id),
          "UUID",
        )},
        ${sql.array(
          batch.map((row) => row.shortId),
          "TEXT",
        )},
        ${sql.array(
          batch.map((row) => row.parentId ?? ""),
          "TEXT",
        )},
        ${sql.array(
          batch.map((row) => row.title),
          "TEXT",
        )},
        ${sql.array(
          batch.map((row) => row.contentMd),
          "TEXT",
        )},
        ${sql.array(
          batch.map((row) => row.at),
          "TEXT",
        )}::timestamptz[]
      ) AS input(id, short_id, parent_text, title, content_md, at)
      CROSS JOIN LATERAL (SELECT NULLIF(parent_text, '')::uuid AS parent_id) parent
    `;
  }
  const links = tree.flatMap((note, index) => note.links.map((target) => [notes[index]!.id, notes[target]!.id] as const));
  for (let start = 0; start < links.length; start += BATCH) {
    const batch = links.slice(start, start + BATCH);
    await sql`
      INSERT INTO notebooks.note_links (source_note_id, target_note_id)
      SELECT * FROM unnest(${sql.array(
        batch.map(([source]) => source),
        "UUID",
      )}, ${sql.array(
        batch.map(([, target]) => target),
        "UUID",
      )})
      ON CONFLICT DO NOTHING
    `;
  }
  const tags = tree.flatMap((note, index) => note.tags.map((tag) => [notes[index]!.id, tag] as const));
  for (let start = 0; start < tags.length; start += BATCH) {
    const batch = tags.slice(start, start + BATCH);
    await sql`
      INSERT INTO notebooks.note_tags (note_id, notebook_id, tag)
      SELECT note_id, ${notebook.id}::uuid, tag
      FROM unnest(${sql.array(
        batch.map(([id]) => id),
        "UUID",
      )}, ${sql.array(
        batch.map(([, tag]) => tag),
        "TEXT",
      )}) AS input(note_id, tag)
    `;
  }
  // Statistics for the columns queries filter and sort by, so plans match a notebook that grew over time. A whole-table
  // ANALYZE also samples Markdown and search vectors and takes minutes on a busy machine.
  await sql`ANALYZE notebooks.notes (id, notebook_id, parent_id, title, position, created_at, updated_at)`;
  await sql`ANALYZE notebooks.note_links, notebooks.note_tags`;
  const children = new Map<number, number[]>();
  tree.forEach((note, index) => {
    if (note.parent !== null) children.set(note.parent, [...(children.get(note.parent) ?? []), index]);
  });
  const [folder, pages] = [...children].sort((left, right) => right[1].length - left[1].length)[0]!;
  const pick = (index: number) => ({ id: notes[index]!.id, shortId: notes[index]!.shortId });
  return {
    ...notebook,
    notes: rows.map((row) => ({ id: row.id, shortId: row.shortId, parentId: row.parentId, title: row.title })),
    folder: pick(folder),
    page: pick(pages.at(-1)!),
    other: pick(pages[0]!),
    remove: async () => {
      inserted.delete(notebook.id);
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
    },
  };
}

/** Removes every fixture notebook this process inserted; an `afterAll` calls it instead of trusting its setup finished. */
export async function removeFixtureNotebooks(): Promise<void> {
  const ids = [...inserted];
  inserted.clear();
  if (ids.length > 0) await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(${sql.array(ids, "UUID")})`;
}
