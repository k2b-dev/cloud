import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { record } from "./activity";
import { attachmentFigures, FIGURE_DAYS, notesFigures } from "./notebook-figures";
import { listPages } from "./page-list";

// The head of the notes list and the attachments page: changes and uploads per day in the person's time zone, from a
// fixed window of the notebook's activity; each note's latest editors from its last changes, the last one first.
const suite = databaseSuite();
suite("notebook figures and the editors of the notes list", () => {
  const notebookId = crypto.randomUUID();
  const other = crypto.randomUUID();
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const now = new Date("2026-11-20T10:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const noteIds: string[] = [];

  beforeAll(async () => {
    await migrate();
    for (const [index, id] of users.entries())
      await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile)
        VALUES (${id}::uuid, ${`figures-${id}`}, ${index === 0 ? "Ada Renz" : "Jonas Kern"}, 'local', 'user')`;
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'Figures')`;
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${other}::uuid, ${testShortId()}, 'Other')`;
    for (const created of [hoursAgo(2), hoursAgo(24 * 40)]) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO notebooks.notes (short_id, notebook_id, title, created_at, updated_at)
        VALUES (${testShortId()}, ${notebookId}::uuid, ${`Note ${noteIds.length + 1}`}, ${created}, ${created})
        RETURNING id`;
      noteIds.push(row!.id);
    }
  });
  afterAll(async () => {
    await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebookId}::uuid, ${other}::uuid)`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("changes per day fill a fixed window ending today in the person's time zone; older and other activity stays out", async () => {
    const [first, second] = noteIds as [string, string];
    const change = (noteId: string, user: string, at: Date, action: "note.edited" | "note.created" | "comment.created" = "note.edited") =>
      record({ notebookId, noteId, actor: { kind: "user", id: user }, action, occurredAt: at });
    await change(first, users[0]!, hoursAgo(2), "note.created");
    await change(first, users[1]!, hoursAgo(1));
    // 23:30 UTC on 19.11. is already the 20th in Berlin: today there, yesterday in UTC
    await change(second, users[0]!, new Date("2026-11-19T23:30:00Z"));
    await change(second, users[0]!, hoursAgo(24 * 3));
    // outside the window, a comment, and another notebook do not count
    await change(second, users[1]!, hoursAgo(24 * 45));
    await change(first, users[1]!, hoursAgo(3), "comment.created");
    await record({ notebookId: other, actor: { kind: "user", id: users[0]! }, action: "notebook.created", occurredAt: hoursAgo(1) });

    const berlin = await notesFigures({ notebookId, timeZone: "Europe/Berlin", now });
    expect(berlin.days).toHaveLength(FIGURE_DAYS);
    expect(berlin.days.at(-1)).toBe(3);
    expect(berlin.days.at(-4)).toBe(1);
    expect(berlin.changes).toBe(4);
    expect(berlin.people).toBe(2);
    expect(berlin.notes).toBe(2);
    expect(berlin.newNotes).toBe(1);
    expect(berlin.latest).toMatchObject({ actor: { kind: "user", id: users[1], displayName: "Jonas Kern" }, note: { title: "Note 1" } });

    const utc = await notesFigures({ notebookId, timeZone: "UTC", now });
    expect(utc.days.at(-1)).toBe(2);
    expect(utc.days.at(-2)).toBe(1);

    const quiet = await notesFigures({ notebookId: other, timeZone: "UTC", now });
    expect(quiet).toMatchObject({ changes: 0, people: 0, notes: 0, newNotes: 0, latest: null });
    // a plain array, not the driver's Int32Array: the series travels to the browser in the island's props
    expect(Array.isArray(quiet.days)).toBeTrue();
    expect(quiet.days).toEqual(Array.from({ length: FIGURE_DAYS }, () => 0));

    // each note's editors: distinct people from its last changes, the last one first; comments name no editor
    const page = await listPages({
      notebookId,
      userId: users[0]!,
      favorite: undefined,
      tag: null,
      search: null,
      sort: "title",
      offset: 0,
      limit: 10,
    });
    expect(page.items.map((item) => [item.title, item.editors.map((editor) => editor.name)])).toEqual([
      ["Note 1", ["Jonas Kern", "Ada Renz"]],
      ["Note 2", ["Ada Renz", "Jonas Kern"]],
    ]);
  });

  test("attachments count the whole notebook, their bytes, and uploads per day in the window", async () => {
    const upload = (name: string, bytes: number, at: Date) =>
      sql`INSERT INTO notebooks.attachments (notebook_id, filename, mime_type, size_bytes, kind, content, created_at)
        VALUES (${notebookId}::uuid, ${name}, 'application/pdf', ${bytes}, 'file', ${Buffer.from("x")}, ${at})`;
    await upload("today.pdf", 1_000, hoursAgo(1));
    await upload("week.pdf", 2_000, hoursAgo(24 * 6));
    await upload("old.pdf", 4_000, hoursAgo(24 * 90));
    const figures = await attachmentFigures({ notebookId, timeZone: "UTC", now });
    expect(figures).toMatchObject({ count: 3, bytes: 7_000, added: 2 });
    expect(Array.isArray(figures.days)).toBeTrue();
    expect(figures.days).toHaveLength(FIGURE_DAYS);
    expect(figures.days.at(-1)).toBe(1);
    expect(figures.days.at(-7)).toBe(1);
    expect(figures.days.reduce((sum, value) => sum + value, 0)).toBe(2);
  });
});
