import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import * as items from "./items";
import * as spaces from "./spaces";
import * as wormholes from "./wormholes";

type Pending = { payload: { a?: true; d?: { type: string; itemId?: string } } };

// Publishing and reading the topic is covered by the platform's own live outbox test.
const suite = databaseSuite();
const spaceIds: string[] = [];
let userId = "";

beforeAll(async () => {
  if (!testInfra.database) return;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${`spaces-live-${crypto.randomUUID()}`}, 'local', 'user', 'Ada Example') RETURNING id`;
  userId = user!.id;
});

afterAll(async () => {
  if (!userId) return;
  if (spaceIds.length > 0) {
    await sql`DELETE FROM events.outbox WHERE app_id = 'spaces' AND ordering_key IN ${sql(spaceIds)}`;
    await sql`DELETE FROM spaces.spaces WHERE id IN ${sql(spaceIds)}`;
  }
  await sql`DELETE FROM auth.access WHERE user_id = ${userId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
});

const space = async (name: string) => {
  const created = await spaces.create({ data: { name, starter: "tasks", color: "#3b82f6" }, creatorId: userId });
  if (!created.ok) throw new Error(created.error);
  spaceIds.push(created.data.id);
  const [column] = await sql<
    { id: string }[]
  >`SELECT id FROM spaces.columns WHERE space_id = ${created.data.id}::uuid ORDER BY rank LIMIT 1`;
  return { id: created.data.id, columnId: column!.id };
};

const pendingFor = async (spaceId: string) =>
  (await sql<Pending[]>`SELECT payload FROM events.outbox WHERE app_id = 'spaces' AND ordering_key = ${spaceId} ORDER BY seq`).map((row) =>
    row.payload.a ? "access" : row.payload.d,
  );

const shortIdOf = async (itemId: string) =>
  (await sql<{ short_id: string }[]>`SELECT short_id FROM spaces.items WHERE id = ${itemId}::uuid`)[0]!.short_id;

suite("Spaces live updates", () => {
  test("a write and its live update commit together, under the item's public ID", async () => {
    const board = await space("Live board");
    // The creator's grant is an access change of its own.
    expect(await pendingFor(board.id)).toEqual(["access", { type: "access.changed" }]);

    const created = await items.create({
      spaceId: board.id,
      data: { columnId: board.columnId, title: "Write the plan" },
      createdBy: userId,
    });
    if (!created.ok) throw new Error(created.error);
    const itemId = await shortIdOf(created.data.id);
    // A refused change announces nothing.
    expect((await items.move({ id: created.data.id, columnId: board.columnId, afterItemId: created.data.id })).ok).toBe(false);
    expect((await items.setCompleted({ id: created.data.id, completed: true })).ok).toBe(true);
    expect((await items.remove({ id: created.data.id })).ok).toBe(true);

    expect((await pendingFor(board.id)).slice(2)).toEqual([
      { type: "item.created", itemId },
      { type: "item.completed", itemId },
      { type: "item.deleted", itemId },
    ]);
  });

  test("a transfer reaches both Spaces; a deleted Space is an access change", async () => {
    const source = await space("Live source");
    const target = await space("Live target");
    const actor = { subject: { type: "user" as const, userId }, resourceBoundSpaceId: null };
    const wormhole = await wormholes.create({
      sourceSpaceId: source.id,
      data: { targetColumnId: target.columnId, color: "#6366f1" },
      actor,
    });
    if (!wormhole.ok) throw new Error(wormhole.error);
    const [wormholeRow] = await sql<{ id: string }[]>`SELECT id FROM spaces.wormholes WHERE source_space_id = ${source.id}::uuid`;
    const created = await items.create({ spaceId: source.id, data: { columnId: source.columnId, title: "Hand over" }, createdBy: userId });
    if (!created.ok) throw new Error(created.error);
    const itemId = await shortIdOf(created.data.id);

    const moved = await wormholes.transfer({ sourceSpaceId: source.id, itemId: created.data.id, wormholeId: wormholeRow!.id, actor });
    expect(moved.ok).toBe(true);
    expect((await pendingFor(source.id)).slice(2)).toEqual([
      { type: "wormhole.created" },
      { type: "item.created", itemId },
      { type: "item.transferred", itemId },
    ]);
    expect((await pendingFor(target.id)).slice(2)).toEqual([{ type: "item.transferred", itemId }]);

    expect((await spaces.remove({ id: target.id })).ok).toBe(true);
    expect((await pendingFor(target.id)).slice(3)).toEqual(["access", { type: "space.deleted" }]);
  });
});
