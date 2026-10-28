import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { runNotebookActivity } from "../capabilities";
import { ActivityInputSchema } from "../capability-contracts";
import { migrate } from "../migrate";
import { record } from "./activity";

const suite = databaseSuite();
suite("notebook.activity permission and paging contract", () => {
  const userId = crypto.randomUUID();
  const notebooks = [crypto.randomUUID(), crypto.randomUUID()];
  const publicIds = [testShortId(), testShortId()];
  const accessId = crypto.randomUUID();
  let context: CapabilityExecutionContext;
  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile) VALUES (${userId}::uuid, ${`activity-${userId}`}, 'Lena', 'local', 'user')`;
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing test user");
    context = {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId },
      user,
      locale: "de",
      requestId: "activity-test",
      origin: "app",
      signal: new AbortController().signal,
    };
    for (let index = 0; index < notebooks.length; index++)
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebooks[index]!}::uuid, ${publicIds[index]!}, 'Activity')`;
    await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
    await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebooks[0]!}::uuid, ${accessId}::uuid)`;
  });
  afterAll(async () => {
    for (const id of notebooks) await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  const note = async (index = 0) => {
    const [entry] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO notebooks.notes (short_id, notebook_id, title) VALUES (${testShortId()}, ${notebooks[index]!}::uuid, 'Note') RETURNING id, short_id`;
    return entry!;
  };
  const read = (input: Record<string, unknown> = {}) =>
    runNotebookActivity(ActivityInputSchema.parse({ notebook: publicIds[0], ...input }), context);
  test("omits inaccessible, deleted, relocated and comment activity before pagination", async () => {
    const visible = await note(),
      hidden = await note(1),
      deleted = await note();
    for (const [entry, index] of [
      [visible, 0],
      [hidden, 1],
      [deleted, 0],
    ] as const)
      await record({
        notebookId: notebooks[index]!,
        noteId: entry.id,
        actor: { kind: "user", id: userId },
        action: "note.edited",
        occurredAt: new Date("2026-10-23T10:00:00Z"),
      });
    await record({ notebookId: notebooks[0]!, noteId: hidden.id, actor: { kind: "system", id: null }, action: "note.edited" });
    await record({ notebookId: notebooks[0]!, noteId: visible.id, actor: { kind: "user", id: userId }, action: "comment.created" });
    await sql`DELETE FROM notebooks.notes WHERE id = ${deleted.id}::uuid`;
    const page = await read({ limit: 1 });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.data).toEqual([
      expect.objectContaining({ sentence: "Du hast die Notiz bearbeitet", ref: { type: "notebooks.note", id: visible.short_id } }),
    ]);
    expect(page.data.page).toEqual({ hasMore: false });
    const denied = await read({ notebook: publicIds[1] });
    expect(denied.ok).toBeFalse();
    if (!denied.ok) expect(denied.error.status).toBe(404);
    expect((await read({ item: hidden.short_id })).ok).toBeFalse();
  });
  test("preserves bucket identity, time windows, timestamp precision and unknown-action fallback", async () => {
    const entry = await note();
    const actor = { kind: "user" as const, id: userId };
    const bucketStartedAt = new Date("2026-10-23T12:00:00Z");
    const first = await record({
      notebookId: notebooks[0]!,
      noteId: entry.id,
      actor,
      action: "note.edited",
      bucketStartedAt,
      occurredAt: bucketStartedAt,
    });
    expect(
      await record({
        notebookId: notebooks[0]!,
        noteId: entry.id,
        actor,
        action: "note.edited",
        bucketStartedAt,
        occurredAt: new Date("2026-10-23T12:00:01Z"),
      }),
    ).toBe(first);
    const [second] = await sql<
      { id: string | number }[]
    >`INSERT INTO notebooks.activity_events (notebook_id, note_id, actor_kind, actor_id, action, last_occurred_at) VALUES (${notebooks[0]!}::uuid, ${entry.id}::uuid, 'user', ${userId}::uuid, 'old.unknown', '2026-10-23T12:00:00.000456Z') RETURNING id`;
    await sql`UPDATE notebooks.activity_events SET last_occurred_at = '2026-10-23T12:00:00.000123Z'::timestamptz WHERE id = ${first}::bigint`;
    const page = await read({ item: entry.short_id, limit: 1, after: "2026-10-23T11:00:00Z", before: "2026-10-23T13:00:00Z" });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.data).toEqual([expect.objectContaining({ id: String(second!.id), sentence: "Du hast die Notiz geändert" })]);
    const next = await read({ item: entry.short_id, limit: 1, cursor: page.data.page.hasMore ? page.data.page.nextCursor : undefined });
    if (!next.ok) throw new Error(next.error.message);
    expect(next.data.data).toEqual([expect.objectContaining({ id: first, count: 2 })]);
    expect(next.data.page).toEqual({ hasMore: false });
  });
});
