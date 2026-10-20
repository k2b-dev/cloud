import { afterAll, beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { list, noteAuthors, record } from "./activity";

const AVATAR_HASH = "a".repeat(64);
const AVATAR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

const databaseTest = testFor("database");
const notebookId = crypto.randomUUID();
const noteId = crypto.randomUUID();
const creatorId = crypto.randomUUID();
const editorId = crypto.randomUUID();
const formerServiceId = crypto.randomUUID();
const start = new Date("2026-10-01T10:00:00.000Z");
const later = new Date("2026-10-01T11:00:00.000Z");
const latest = new Date("2026-10-01T12:00:00.000Z");

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  for (const [id, name] of [
    [creatorId, "Jana Berger"],
    [editorId, "Last Editor"],
  ]) {
    // The schema keeps a picture and its 64-hex hash together.
    await sql`INSERT INTO auth.users (id, uid, display_name, avatar_data_url, avatar_hash, provider, profile)
      VALUES (${id}::uuid, ${`activity-${id}`}, ${name}, ${AVATAR_DATA_URL}, ${AVATAR_HASH}, 'local', 'user')`;
  }
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${testShortId()}, 'Activity test')`;
  await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, created_by)
    VALUES (${noteId}::uuid, ${testShortId()}, ${notebookId}::uuid, 'Activity note', ${creatorId}::uuid)`;
}, 30_000);

afterAll(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${editorId}::uuid)`;
});

const creator = { kind: "user", id: creatorId, displayName: "Jana Berger", avatarHash: AVATAR_HASH } as const;

databaseTest("note authors resolve creation, latest edits and restores, with legacy and former-actor fallbacks", async () => {
  expect(await noteAuthors({ noteId })).toEqual({ createdBy: creator, lastEditedBy: creator });
  // Creation event takes precedence over the note's legacy created_by column.
  await record({ notebookId, noteId, action: "note.created", actor: { kind: "system", id: null }, occurredAt: start });
  const system = { kind: "system", id: null, displayName: "System", avatarHash: null } as const;
  expect(await noteAuthors({ noteId })).toEqual({ createdBy: system, lastEditedBy: system });
  await record({ notebookId, noteId, action: "note.edited", actor: { kind: "user", id: editorId }, occurredAt: later });
  // Newer comments don't change authorship.
  await record({ notebookId, noteId, action: "comment.created", actor: { kind: "user", id: creatorId }, occurredAt: latest });
  expect((await noteAuthors({ noteId })).lastEditedBy).toEqual({ ...creator, id: editorId, displayName: "Last Editor" });
  await record({
    notebookId,
    noteId,
    action: "note.restored",
    actor: { kind: "service_account", id: formerServiceId },
    occurredAt: latest,
  });
  expect((await noteAuthors({ noteId })).lastEditedBy).toEqual({
    kind: "service_account",
    id: formerServiceId,
    displayName: "Former service account",
    avatarHash: null,
  });
  await sql`DELETE FROM notebooks.activity_events WHERE note_id = ${noteId}::uuid`;
  await sql`UPDATE auth.users SET display_name = '' WHERE id = ${creatorId}::uuid`;
  expect((await noteAuthors({ noteId })).createdBy?.displayName).toBe(`activity-${creatorId}`);
  await sql`UPDATE notebooks.notes SET created_by = NULL WHERE id = ${noteId}::uuid`;
  expect(await noteAuthors({ noteId })).toEqual({ createdBy: null, lastEditedBy: null });
  expect(await noteAuthors({ noteId: crypto.randomUUID() })).toEqual({ createdBy: null, lastEditedBy: null });
});

databaseTest(
  "unknown actions never fill a page, so paging always reaches older supported events; action filters stay bounded",
  async () => {
    await sql`DELETE FROM notebooks.activity_events WHERE note_id = ${noteId}::uuid`;
    const createdId = await record({
      notebookId,
      noteId,
      action: "note.created",
      actor: { kind: "user", id: creatorId },
      occurredAt: start,
    });
    const editedId = await record({ notebookId, noteId, action: "note.edited", actor: { kind: "user", id: editorId }, occurredAt: later });
    for (let index = 0; index < 3; index++) {
      await sql`INSERT INTO notebooks.activity_events (notebook_id, note_id, actor_kind, action, created_at, last_occurred_at)
      VALUES (${notebookId}::uuid, ${noteId}::uuid, 'system', 'note.moved', ${latest}, ${latest})`;
    }
    const params = { bypassAccess: true, noteId, limit: 1 };
    // Newer unknown rows (left by a rollback) are filtered before the limit: the first page is the newest supported event.
    const first = await list(params);
    expect(first.items.map(({ id }) => id)).toEqual([editedId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ ...params, cursor: first.nextCursor! });
    expect(second.items.map(({ id }) => id)).toEqual([createdId]);
    expect(second.nextCursor).toBeNull();
    const filtered = await list({ ...params, actions: ["note.created"] });
    expect(filtered.items.map(({ id }) => id)).toEqual([createdId]);
    expect(filtered.nextCursor).toBeNull();
    expect(await list({ ...params, actions: [] })).toEqual({ items: [], nextCursor: null });
  },
);
