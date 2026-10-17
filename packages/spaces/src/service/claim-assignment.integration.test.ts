import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { backfillClaimAssignees } from "../migrate";
import { get, listFiltered, setAssignees, setCompleted, update } from "./items";
import { change, read } from "./task-work";

const suite = databaseSuite();
const claimed = {
  ok: false,
  status: 409,
  error: "Task is claimed; release its current claim before changing ownership or completing it",
} as const;
const CLAIMED_AT = "2026-10-01T09:00:00.000Z";

const withFixture = async (run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) => {
  const spaceId = crypto.randomUUID();
  const holderId = crypto.randomUUID();
  const writerId = crypto.randomUUID();
  const accessIds = [crypto.randomUUID(), crypto.randomUUID()];
  try {
    await run(await createFixture(spaceId, holderId, writerId, accessIds));
  } finally {
    await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of [holderId, writerId]) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  }
};

const createFixture = async (spaceId: string, holderId: string, writerId: string, accessIds: string[]) => {
  await sql`INSERT INTO spaces.spaces (id, short_id, name) VALUES (${spaceId}::uuid, ${newShortId()}, 'Claim assignment')`;
  for (const [index, id] of [holderId, writerId].entries()) {
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${id}::uuid, ${`claim-assignment-${id}`}, 'local', 'user', ${index === 0 ? "Holder" : "Writer"})`;
    await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessIds[index]}::uuid, ${id}::uuid, 'write')`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${accessIds[index]}::uuid)`;
  }
  const [open] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
    VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024, false), (${newShortId()}, ${spaceId}::uuid, 'Done', 2048, true) RETURNING id`;
  const newTask = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
      VALUES (${newShortId()}, ${spaceId}::uuid, ${open!.id}::uuid, 'Original title') RETURNING id`;
    return row!.id;
  };
  const itemId = await newTask();
  const holder = { kind: "user" as const, id: holderId };
  const writer = { kind: "user" as const, id: writerId };
  const context = (actor = holder) => ({ itemId, spaceId, actor, subject: { type: "user" as const, userId: actor.id, groupIds: [] } });
  const assignees = async (id = itemId) =>
    (await sql<{ user_id: string }[]>`SELECT user_id FROM spaces.item_assignees WHERE item_id = ${id}::uuid ORDER BY user_id`).map(
      (row) => row.user_id,
    );
  const takeOvers = () => sql<{ actor_id: string; metadata: unknown }[]>`
    SELECT actor_id, metadata FROM spaces.activity_events WHERE item_id = ${itemId}::uuid AND action = 'task.taken_over'`;
  const claimId = crypto.randomUUID();
  const claim = async () => {
    expect(await change({ ...context(), operation: "claim", claimId })).toMatchObject({ ok: true });
  };
  return { spaceId, itemId, holder, writer, claimId, claim, context, assignees, takeOvers, newTask };
};

suite("Spaces user claim assignments", () => {
  test("claiming assigns exactly once, including retries, and changes assignment filters", async () => {
    await withFixture(async (f) => {
      expect(await f.assignees()).toEqual([]);
      await f.claim();
      await f.claim();
      expect(await f.assignees()).toEqual([f.holder.id]);
      expect((await get({ id: f.itemId }))?.assignees?.map((user) => user.id)).toEqual([f.holder.id]);
      const unassigned = await listFiltered({
        spaceId: f.spaceId,
        filter: ItemFilterSchema.parse({ type: "task", assignedTo: "unassigned" }),
      });
      expect(unassigned.items).toEqual([]);
      const mine = await listFiltered({
        spaceId: f.spaceId,
        currentUserId: f.holder.id,
        filter: ItemFilterSchema.parse({ type: "task", assignedTo: "me" }),
      });
      expect(mine.items.map((item) => item.id)).toEqual([f.itemId]);
      const events = await sql<{ action: string }[]>`SELECT action FROM spaces.activity_events WHERE item_id = ${f.itemId}::uuid`;
      expect(events).toEqual([{ action: "task.claimed" }]);
    });
  });

  test.each([false, true])("releasing your own claim keeps the assignment (force=%s)", async (force) => {
    await withFixture(async (f) => {
      await f.claim();
      expect(await change({ ...f.context(), operation: "release", claimId: f.claimId, force })).toMatchObject({ ok: true });
      expect((await read(f.itemId)).claim).toBeNull();
      expect(await f.assignees()).toEqual([f.holder.id]);
      expect(await f.takeOvers()).toEqual([]);
    });
  });

  test("update refuses a stale assignee list before writing other fields", async () => {
    await withFixture(async (f) => {
      await f.claim();
      const before = await get({ id: f.itemId });
      expect(await update({ id: f.itemId, data: { assigneeIds: [f.writer.id], title: "Must not save" }, actor: f.writer })).toEqual(
        claimed,
      );
      expect(await get({ id: f.itemId })).toEqual(before);
      expect(await f.assignees()).toEqual([f.holder.id]);
      expect((await read(f.itemId)).claim?.id).toBe(f.claimId);
      expect(await f.takeOvers()).toEqual([]);
    });
  });

  test("setAssignees refuses removal of the holder without a claim ID", async () => {
    await withFixture(async (f) => {
      await f.claim();
      expect(await setAssignees({ id: f.itemId, userIds: [], actor: f.holder })).toEqual(claimed);
      expect(await f.assignees()).toEqual([f.holder.id]);
      expect((await read(f.itemId)).claim?.id).toBe(f.claimId);
      expect(await f.takeOvers()).toEqual([]);
    });
  });

  for (const method of ["update", "setAssignees"] as const) {
    const replace = (
      f: Awaited<ReturnType<typeof createFixture>>,
      userIds: string[],
      actor = f.holder,
      claimId?: string,
      force?: boolean,
    ) =>
      method === "update"
        ? update({ id: f.itemId, data: { assigneeIds: userIds, claimId, force }, actor })
        : setAssignees({ id: f.itemId, userIds, actor, claimId, force });

    test(`${method}: holder can remove themselves and end their claim without a take-over`, async () => {
      await withFixture(async (f) => {
        await f.claim();
        expect(await replace(f, [], f.holder, f.claimId)).toMatchObject({ ok: true });
        expect((await read(f.itemId)).claim).toBeNull();
        expect(await f.assignees()).toEqual([]);
        expect(await f.takeOvers()).toEqual([]);
      });
    });

    test(`${method}: another writer must force the exact claim to remove the holder`, async () => {
      await withFixture(async (f) => {
        await f.claim();
        expect(await replace(f, [], f.writer, f.claimId)).toEqual(claimed);
        expect(await replace(f, [], f.writer, f.claimId, true)).toMatchObject({ ok: true });
        expect((await read(f.itemId)).claim).toBeNull();
        expect(await f.assignees()).toEqual([]);
        expect(await f.takeOvers()).toEqual([
          { actor_id: f.writer.id, metadata: expect.objectContaining({ from: f.holder, fromName: "Holder" }) },
        ]);
      });
    });

    test.each([false, true])(`${method}: a stale claim ID refuses removal without changes (force=%s)`, async (force) => {
      await withFixture(async (f) => {
        await f.claim();
        const before = await get({ id: f.itemId });
        expect(await replace(f, [], force ? f.writer : f.holder, crypto.randomUUID(), force)).toMatchObject({ ok: false, status: 409 });
        expect(await get({ id: f.itemId })).toEqual(before);
        expect(await f.assignees()).toEqual([f.holder.id]);
        expect((await read(f.itemId)).claim?.id).toBe(f.claimId);
        expect(await f.takeOvers()).toEqual([]);
      });
    });

    test(`${method}: keeping the holder ignores claim fields and preserves the claim`, async () => {
      await withFixture(async (f) => {
        await f.claim();
        expect(await replace(f, [f.holder.id, f.writer.id], f.writer)).toMatchObject({ ok: true });
        expect(await replace(f, [f.holder.id], f.writer, crypto.randomUUID(), true)).toMatchObject({ ok: true });
        expect(await f.assignees()).toEqual([f.holder.id]);
        expect((await read(f.itemId)).claim?.id).toBe(f.claimId);
        expect(await f.takeOvers()).toEqual([]);
      });
    });
  }

  test("forced release clears the previous holder's assignment, and a new claim assigns the taker", async () => {
    await withFixture(async (f) => {
      await f.claim();
      expect(await change({ ...f.context(f.writer), operation: "release", claimId: f.claimId, force: true })).toMatchObject({ ok: true });
      expect((await read(f.itemId)).claim).toBeNull();
      expect(await f.assignees()).toEqual([]);
      expect(await f.takeOvers()).toEqual([
        { actor_id: f.writer.id, metadata: expect.objectContaining({ from: f.holder, fromName: "Holder" }) },
      ]);
      expect(await change({ ...f.context(f.writer), operation: "claim", claimId: crypto.randomUUID() })).toMatchObject({ ok: true });
      expect(await f.assignees()).toEqual([f.writer.id]);
      expect((await read(f.itemId)).claim?.actor).toEqual(f.writer);
    });
  });

  test("completing with the claim keeps the assignees", async () => {
    await withFixture(async (f) => {
      await f.claim();
      expect(await setCompleted({ id: f.itemId, completed: true, claimId: f.claimId, actor: f.holder })).toMatchObject({ ok: true });
      expect((await read(f.itemId)).claim).toBeNull();
      expect(await f.assignees()).toEqual([f.holder.id]);
    });
  });

  test("backfill reads the claim again under the item lock, so a release in flight is not undone", async () => {
    await withFixture(async (f) => {
      // An older release left this claim without its assignment; a release that has not committed yet ends it.
      const claim = { id: f.claimId, actor: f.holder, claimedAt: CLAIMED_AT };
      await sql`INSERT INTO spaces.task_work (item_id, claim) VALUES (${f.itemId}::uuid, ${claim}::jsonb)`;
      let commit!: () => void;
      const committed = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let locked!: () => void;
      const holdsLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM spaces.items WHERE id = ${f.itemId}::uuid FOR UPDATE`;
        await tx`UPDATE spaces.task_work SET claim = NULL WHERE item_id = ${f.itemId}::uuid`;
        locked();
        await committed;
      });
      await holdsLock;
      const backfill = backfillClaimAssignees();
      // Give the backfill time to see the claim before the release commits; it must then wait for the lock.
      await Bun.sleep(200);
      commit();
      await release;
      await backfill;
      expect((await read(f.itemId)).claim).toBeNull();
      expect(await f.assignees()).toEqual([]);
    });
  });

  test("backfill repairs user claims idempotently and skips deleted users and service accounts", async () => {
    await withFixture(async (f) => {
      const deletedItemId = await f.newTask();
      const serviceItemId = await f.newTask();
      const malformedServiceItemId = await f.newTask();
      const seed = async (itemId: string, actor: { kind: string; id: string }) => {
        const claim = { id: crypto.randomUUID(), actor, claimedAt: CLAIMED_AT };
        await sql`INSERT INTO spaces.task_work (item_id, claim) VALUES (${itemId}::uuid, ${claim}::jsonb)`;
      };
      await seed(f.itemId, f.holder);
      await seed(deletedItemId, { kind: "user", id: crypto.randomUUID() });
      // Use an existing user's UUID as a service actor to prove the kind, not only the join, excludes it.
      await seed(serviceItemId, { kind: "service_account", id: f.writer.id });
      await seed(malformedServiceItemId, { kind: "service_account", id: "not-a-uuid" });
      expect(await f.assignees()).toEqual([]);
      expect(await backfillClaimAssignees()).toBeGreaterThanOrEqual(1);
      expect(await f.assignees()).toEqual([f.holder.id]);
      await backfillClaimAssignees();
      expect(await f.assignees()).toEqual([f.holder.id]);
      for (const id of [deletedItemId, serviceItemId, malformedServiceItemId]) expect(await f.assignees(id)).toEqual([]);
    });
  });
});
