import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { runSpaceActivity } from "../capabilities";
import { ActivityInputSchema } from "../capability-contracts";
import { migrate } from "../migrate";
import { record } from "./activity";

const suite = databaseSuite();
suite("space.activity permission and paging contract", () => {
  const userId = crypto.randomUUID();
  const spaces = [crypto.randomUUID(), crypto.randomUUID()];
  const publicIds = [testShortId(), testShortId()];
  const accessId = crypto.randomUUID();
  let context: CapabilityExecutionContext;
  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile) VALUES (${userId}::uuid, ${`activity-${userId}`}, 'Mara', 'local', 'user')`;
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
    for (let index = 0; index < spaces.length; index++)
      await sql`INSERT INTO spaces.spaces (id, short_id, name) VALUES (${spaces[index]!}::uuid, ${publicIds[index]!}, 'Activity')`;
    await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaces[0]!}::uuid, ${accessId}::uuid)`;
  });
  afterAll(async () => {
    for (const id of spaces) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  const item = async (spaceIndex = 0) => {
    const [column] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${testShortId()}, ${spaces[spaceIndex]!}::uuid, 'Open', 1024) RETURNING id`;
    const [item] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO spaces.items (short_id, space_id, column_id, title) VALUES (${testShortId()}, ${spaces[spaceIndex]!}::uuid, ${column!.id}::uuid, 'Task') RETURNING id, short_id`;
    return item!;
  };
  const read = (input: Record<string, unknown> = {}) =>
    runSpaceActivity(ActivityInputSchema.parse({ space: publicIds[0], ...input }), context);
  test("omits inaccessible, deleted, relocated and comment activity before pagination", async () => {
    const visible = await item(),
      hidden = await item(1),
      deleted = await item();
    for (const [entry, spaceIndex] of [
      [visible, 0],
      [hidden, 1],
      [deleted, 0],
    ] as const)
      await record({
        spaceId: spaces[spaceIndex]!,
        itemId: entry.id,
        actor: { kind: "user", id: userId },
        action: "task.created",
        occurredAt: new Date("2026-10-23T10:00:00Z"),
      });
    await record({ spaceId: spaces[0]!, itemId: hidden.id, actor: { kind: "system", id: null }, action: "item.moved" });
    await record({ spaceId: spaces[0]!, itemId: visible.id, actor: { kind: "user", id: userId }, action: "comment.created" });
    await sql`DELETE FROM spaces.items WHERE id = ${deleted.id}::uuid`;
    const page = await read({ limit: 1 });
    expect(page.ok).toBeTrue();
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.data).toEqual([
      expect.objectContaining({ sentence: "Du hast die Aufgabe erstellt", ref: { type: "spaces.item", id: visible.short_id } }),
    ]);
    expect(page.data.page).toEqual({ hasMore: false });
    const denied = await read({ space: publicIds[1] });
    expect(denied.ok).toBeFalse();
    if (!denied.ok) expect(denied.error.status).toBe(404);
    expect((await read({ item: hidden.short_id })).ok).toBeFalse();
  });
  test("retains timestamp precision, bounds time windows and keeps bucket metadata", async () => {
    const entry = await item();
    const actor = { kind: "user" as const, id: userId };
    const first = await record({ spaceId: spaces[0]!, itemId: entry.id, actor, action: "task.created" });
    const second = await record({ spaceId: spaces[0]!, itemId: entry.id, actor, action: "task.completed" });
    await sql`UPDATE spaces.activity_events SET last_occurred_at = '2026-10-23T12:00:00.000123Z'::timestamptz WHERE id = ${first}::bigint`;
    await sql`UPDATE spaces.activity_events SET last_occurred_at = '2026-10-23T12:00:00.000456Z'::timestamptz WHERE id = ${second}::bigint`;
    const page = await read({ item: entry.short_id, limit: 1, after: "2026-10-23T11:00:00Z", before: "2026-10-23T13:00:00Z" });
    if (!page.ok) throw new Error(page.error.message);
    expect(page.data.data.map((event) => event.id)).toEqual([second]);
    const next = await read({ item: entry.short_id, limit: 1, cursor: page.data.page.hasMore ? page.data.page.nextCursor : undefined });
    if (!next.ok) throw new Error(next.error.message);
    expect(next.data.data.map((event) => event.id)).toEqual([first]);
    const bucketStartedAt = new Date("2026-10-23T14:00:00Z");
    for (const metadata of [{ changed: ["description"] }, { changed: ["deadline"], deadline: "2026-10-25" }])
      await record({ spaceId: spaces[0]!, itemId: entry.id, actor, action: "task.updated", metadata, bucketStartedAt });
    const [bucket] = await sql<
      { metadata: { changed: string[]; deadline: string }; occurrence_count: number }[]
    >`SELECT metadata, occurrence_count FROM spaces.activity_events WHERE item_id = ${entry.id}::uuid AND action = 'task.updated'`;
    expect(bucket?.metadata.changed.toSorted()).toEqual(["deadline", "description"]);
    expect(bucket?.metadata.deadline).toBe("2026-10-25");
    expect(bucket?.occurrence_count).toBe(2);
  });
});
