import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import * as attachments from "./item-attachments";
import * as items from "./items";

const suite = databaseSuite();
suite("Spaces mutations record presentation facts in their transaction", () => {
  const spaceId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    accessId = crypto.randomUUID();
  const columns = [crypto.randomUUID(), crypto.randomUUID()];
  const actor = { kind: "user" as const, id: userId };
  beforeEach(() => setSystemTime(new Date("2026-10-24T12:00:00Z")));
  afterEach(() => setSystemTime());
  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO auth.users (id, uid, display_name, provider, profile) VALUES (${userId}::uuid, ${`activity-${userId}`}, 'Mara', 'local', 'user')`;
    await sql`INSERT INTO spaces.spaces (id, short_id, name) VALUES (${spaceId}::uuid, ${testShortId()}, 'Activity recording')`;
    for (const [index, id] of columns.entries())
      await sql`INSERT INTO spaces.columns (id, short_id, space_id, name, rank) VALUES (${id}::uuid, ${testShortId()}, ${spaceId}::uuid, ${index ? "In review" : "Open"}, ${(index + 1) * 1024})`;
    await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'write')`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${accessId}::uuid)`;
  });
  afterAll(async () => {
    await sql`DELETE FROM events.outbox WHERE app_id = 'spaces' AND ordering_key = ${spaceId}`;
    await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  const task = async () => {
    const [entry] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.items (short_id, space_id, column_id, title) VALUES (${testShortId()}, ${spaceId}::uuid, ${columns[0]!}::uuid, 'Task') RETURNING id`;
    return entry!.id;
  };
  const recorded = async (id: string, action: string) => {
    const [row] = await sql<
      { metadata: Record<string, unknown>; actor_kind: string; actor_id: string }[]
    >`SELECT metadata, actor_kind, actor_id FROM spaces.activity_events WHERE item_id = ${id}::uuid AND action = ${action} ORDER BY id DESC LIMIT 1`;
    if (!row) throw new Error("Missing recorded event");
    return row;
  };
  test("updates retain changed fields, dates, target status and principal differences", async () => {
    const id = await task();
    expect((await items.update({ id, actor, data: { deadline: "2026-10-23", description: "Private description" } })).ok).toBeTrue();
    expect((await recorded(id, "task.updated")).metadata).toMatchObject({ changed: ["description", "deadline"], deadline: "2026-10-23" });
    expect(JSON.stringify((await recorded(id, "task.updated")).metadata)).not.toContain("Private description");
    expect((await items.move({ id, actor, columnId: columns[1]! })).ok).toBeTrue();
    expect((await recorded(id, "item.moved")).metadata).toMatchObject({ columnId: columns[1], columnName: "In review" });
    expect((await items.setAssignees({ id, actor, userIds: [userId] })).ok).toBeTrue();
    expect((await recorded(id, "item.assignees.updated")).metadata).toMatchObject({ added: [userId], removed: [] });
    expect((await items.setAssignees({ id, actor, userIds: [] })).ok).toBeTrue();
    expect((await recorded(id, "item.assignees.updated")).metadata).toMatchObject({ added: [], removed: [userId] });
  });
  test("attachments preserve filename and actual actor on add and delete", async () => {
    const id = await task();
    const uploaded = await attachments.upload({
      itemId: id,
      spaceId,
      actor,
      userId,
      filename: "Raumplan-v3.pdf",
      mimeType: "application/pdf",
      content: new TextEncoder().encode("fixture"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await recorded(id, "attachment.added")).toMatchObject({
      metadata: { filename: "Raumplan-v3.pdf" },
      actor_kind: "user",
      actor_id: userId,
    });
    expect((await attachments.remove({ shortId: uploaded.data.id, itemId: id, spaceId, actor })).ok).toBeTrue();
    expect(await recorded(id, "attachment.deleted")).toMatchObject({
      metadata: { filename: "Raumplan-v3.pdf" },
      actor_kind: "user",
      actor_id: userId,
    });
    const [count] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM spaces.item_attachments WHERE item_id = ${id}::uuid`;
    expect(count?.n).toBe(0);
  });
});
