import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { listBacklinks } from "./links";

const suite = suiteFor("database", "nats", "valkey");
const identity = () => ({ id: crypto.randomUUID(), shortId: testShortId() });

// #4417: a note linked from a thousand notes is read one bounded page at a time, with the total, in one statement.
suite("Notebooks backlinks", () => {
  test("a note linked from 1,000 notes reads one page and the total in one statement, newest change first, readable sources only", async () => {
    const readable = identity();
    const hidden = identity();
    const target = { ...identity(), title: "Backlinks target" };
    const readerId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const sources = Array.from({ length: 1000 }, () => identity());
    const hiddenSources = Array.from({ length: 5 }, () => identity());
    // the n-th source changed n minutes ago, so the newest first is source 0, 1, 2, …
    const changedAt = (index: number) => new Date(Date.UTC(2026, 10, 20, 12) - index * 60_000);
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
        VALUES (${readerId}::uuid, ${`backlinks-reader-${readerId}`}, 'local', 'user', 'Backlinks reader')`;
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES
        (${readable.id}::uuid, ${readable.shortId}, 'Backlinks readable'),
        (${hidden.id}::uuid, ${hidden.shortId}, 'Backlinks hidden')`;
      await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title)
        VALUES (${target.id}::uuid, ${target.shortId}, ${readable.id}::uuid, ${target.title})`;
      await sql`
        INSERT INTO notebooks.notes (id, short_id, notebook_id, title, updated_at)
        SELECT id, short_id, ${readable.id}::uuid, 'Source ' || ordinality, changed_at
        FROM unnest(${sql.array(
          sources.map((note) => note.id),
          "TEXT",
        )}::uuid[], ${sql.array(
          sources.map((note) => note.shortId),
          "TEXT",
        )}::text[],
          ${sql.array(
            sources.map((_, index) => changedAt(index).toISOString()),
            "TEXT",
          )}::timestamptz[])
          WITH ORDINALITY AS source(id, short_id, changed_at, ordinality)`;
      await sql`
        INSERT INTO notebooks.notes (id, short_id, notebook_id, title)
        SELECT id, short_id, ${hidden.id}::uuid, 'Hidden source'
        FROM unnest(${sql.array(
          hiddenSources.map((note) => note.id),
          "TEXT",
        )}::uuid[], ${sql.array(
          hiddenSources.map((note) => note.shortId),
          "TEXT",
        )}::text[])
          AS source(id, short_id)`;
      await sql`
        INSERT INTO notebooks.note_links (source_note_id, target_note_id)
        SELECT id, ${target.id}::uuid FROM unnest(${sql.array(
          [...sources, ...hiddenSources].map((note) => note.id),
          "TEXT",
        )}::uuid[]) AS source(id)`;
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${readerId}::uuid, 'read')`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${readable.id}::uuid, ${accessId}::uuid)`;

      const meter = await meterSql();
      try {
        let first!: Awaited<ReturnType<typeof listBacklinks>>;
        const statements = await meter.during(async () => {
          first = await listBacklinks({ noteId: target.id, userId: readerId, limit: 100 });
        });
        // one bounded statement for the page and its total, however many notes link here
        expect(statements).toHaveLength(1);
        expect(first.total).toBe(1000);
        expect(first.items).toHaveLength(100);
        expect(first.items[0]).toMatchObject({
          noteId: sources[0]!.shortId,
          notebookId: readable.shortId,
          notebookName: "Backlinks readable",
        });
        expect(first.items.at(-1)?.noteId).toBe(sources[99]!.shortId);

        // the next page continues where the first ended, again in one statement
        let second!: Awaited<ReturnType<typeof listBacklinks>>;
        expect(
          await meter.during(async () => {
            second = await listBacklinks({ noteId: target.id, userId: readerId, limit: 100, offset: 100 });
          }),
        ).toHaveLength(1);
        expect(second.items[0]?.noteId).toBe(sources[100]!.shortId);
        expect(second.total).toBe(1000);
      } finally {
        await meter.close();
      }

      // the last page is short, and a page past the end is empty but still knows the total
      expect(await listBacklinks({ noteId: target.id, userId: readerId, limit: 100, offset: 950 })).toMatchObject({ total: 1000 });
      expect((await listBacklinks({ noteId: target.id, userId: readerId, limit: 100, offset: 950 })).items).toHaveLength(50);
      expect(await listBacklinks({ noteId: target.id, userId: readerId, limit: 100, offset: 2000 })).toEqual({ items: [], total: 1000 });
      // global admins see the hidden notebook's sources too; a stranger sees none
      expect((await listBacklinks({ noteId: target.id, userId: null, bypassAccess: true, limit: 10 })).total).toBe(1005);
      expect(await listBacklinks({ noteId: target.id, userId: crypto.randomUUID(), limit: 10 })).toEqual({ items: [], total: 0 });
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id IN (${readable.id}::uuid, ${hidden.id}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${readerId}::uuid`;
    }
  });
});
