import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { CreateItemSchema, UpdateItemSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { type SpaceTimeBlock, UpdateTimeBlockSchema } from "../time-block-contracts";
import * as blocks from "./time-blocks";

const interval = { startsAt: "2030-03-14T09:00:00Z", endsAt: "2030-03-14T10:00:00Z" };

test("time-block review contract: revision tracks only the block's durable fields", () => {
  const block: SpaceTimeBlock = {
    id: "17010000-0000-4000-8000-000000000001",
    itemId: "Task01",
    ownerId: "17010000-0000-4000-8000-000000000002",
    title: "Plan work",
    ...interval,
    spaceId: "Space1",
    ownerName: "Owner",
    spaceName: "Planning",
    spaceColor: "#000000",
    taskState: "open",
    canWrite: true,
    canDelete: true,
  };
  const revision = blocks.revisionForTimeBlock(block);
  expect(
    blocks.revisionForTimeBlock({
      ...block,
      spaceId: "Space2",
      ownerName: "Renamed owner",
      spaceName: "Renamed Space",
      spaceColor: "#ffffff",
      taskState: "done",
      canWrite: false,
      canDelete: false,
    }),
  ).toBe(revision);
  const changes: Partial<SpaceTimeBlock>[] = [
    { id: "17010000-0000-4000-8000-000000000003" },
    { itemId: null },
    { ownerId: "17010000-0000-4000-8000-000000000004" },
    { title: "Other work" },
    { startsAt: "2030-03-14T09:15:00Z" },
    { endsAt: "2030-03-14T10:15:00Z" },
  ];
  for (const change of changes) expect(blocks.revisionForTimeBlock({ ...block, ...change })).not.toBe(revision);
});

test("time-block review contract: Unicode title limits match public task writes", () => {
  for (const title of ["a".repeat(200), "😀".repeat(100), "😀".repeat(101), "a".repeat(199) + "😀"]) {
    const accepted = CreateItemSchema.safeParse({ columnId: "Column", title }).success;
    expect(UpdateItemSchema.safeParse({ title }).success).toBe(accepted);
    expect(UpdateTimeBlockSchema.safeParse({ title }).success).toBe(accepted);
  }
});

databaseSuite()("Time block backend review", () => {
  const spaceIds: string[] = [],
    userIds: string[] = [];
  beforeAll(migrate);
  beforeEach(() => setSystemTime(new Date("2030-03-14T08:00:00Z")));
  afterEach(async () => {
    for (const id of spaceIds.splice(0)) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    for (const id of userIds.splice(0)) {
      await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
    setSystemTime();
  });
  const scene = async () => {
    const id = crypto.randomUUID();
    userIds.push(id);
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${id}::uuid, ${`block-review-${id}`}, 'local', 'user', 'Owner')`;
    const user = await accounts.users.get({ id });
    if (!user) throw new Error("Missing fixture user");
    const reader = blocks.readerForUser(user);
    const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
      VALUES (${newShortId()}, 'Review') RETURNING id`;
    spaceIds.push(space!.id);
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      VALUES (${id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}, ${access!.id})`;
    const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
      VALUES (${newShortId()}, ${space!.id}, 'Open', 1024) RETURNING id`;
    const [task] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
      VALUES (${newShortId()}, ${space!.id}, ${column!.id}, 'Original task') RETURNING id`;
    await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${task!.id}, ${id}::uuid)`;
    return { userId: id, spaceId: space!.id, taskId: task!.id, reader };
  };

  test("edit and deletion flags preserve existing owner, access and assignment rules", async () => {
    const f = await scene(),
      data = { id: crypto.randomUUID(), ...interval };
    expect(await blocks.create({ itemId: f.taskId, reader: f.reader, data })).toMatchObject({
      ok: true,
      data: { canWrite: true, canDelete: true },
    });
    await sql`DELETE FROM spaces.item_assignees WHERE item_id = ${f.taskId}`;
    expect(await blocks.get({ id: data.id, reader: f.reader })).toMatchObject({
      ok: true,
      data: { canWrite: false, canDelete: false },
    });
    expect(await blocks.remove({ id: data.id, reader: f.reader })).toMatchObject({ ok: false, error: { status: 403 } });
    await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${f.taskId}, ${f.userId}::uuid)`;
    await sql`DELETE FROM spaces.space_access WHERE space_id = ${f.spaceId}`;
    expect(await blocks.get({ id: data.id, reader: f.reader })).toMatchObject({
      ok: true,
      data: { taskState: "no_access", canWrite: false, canDelete: false },
    });
    expect(await blocks.remove({ id: data.id, reader: f.reader })).toMatchObject({ ok: false, error: { status: 403 } });
    await sql`DELETE FROM spaces.items WHERE id = ${f.taskId}`;
    expect(await blocks.get({ id: data.id, reader: f.reader })).toMatchObject({
      ok: true,
      data: { taskState: "deleted", canWrite: false, canDelete: true },
    });
    expect(await blocks.update({ id: data.id, reader: f.reader, data: { title: "Change" } })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await blocks.remove({ id: data.id, reader: f.reader })).toMatchObject({ ok: true });
  });

  test("task-title review guard rejects a changed initial copy and permits an exact creation retry", async () => {
    const f = await scene(),
      data = { id: crypto.randomUUID(), ...interval };
    const input = { itemId: f.taskId, reader: f.reader, data, expectedTaskTitle: "Original task" };
    await sql`UPDATE spaces.items SET title = 'Changed before approval' WHERE id = ${f.taskId}`;
    expect(await blocks.create(input)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await blocks.create({ ...input, expectedTaskTitle: "Changed before approval" })).toMatchObject({
      ok: true,
      data: { title: "Changed before approval" },
    });
    await sql`UPDATE spaces.items SET title = 'Changed after creation' WHERE id = ${f.taskId}`;
    expect(await blocks.create({ ...input, expectedTaskTitle: "Changed before approval" })).toMatchObject({
      ok: true,
      data: { title: "Changed before approval" },
    });
  });
});
