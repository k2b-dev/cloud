import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import * as comments from "./comments";
import * as dependencies from "./item-dependencies";
import { get, listFiltered, move, setCompleted } from "./items";
import { change, read } from "./task-work";

const suite = databaseSuite();

suite("Spaces agent work", () => {
  test("coordinates workers, records service-account handoffs and atomically completes with results", async () => {
    const [space] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Agent work test') RETURNING id`;
    const spaceId = space!.id;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Task worker', 'resource_bound', 'spaces', 'space', ${spaceId}) RETURNING id`;
    const actor = { kind: "service_account" as const, id: account!.id };
    const subject = { type: "service_account" as const, serviceAccountId: account!.id };
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (service_account_id, permission) VALUES (${actor.id}::uuid, 'write') RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${grant!.id}::uuid)`;
    try {
      const columns = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Open', 1024, false), (${newShortId()}, ${spaceId}::uuid, 'Done', 2048, true) RETURNING id`;
      const [task] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'Implement work') RETURNING id`;
      const itemId = task!.id;
      const context = { itemId, spaceId, actor, subject };
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const claims = await Promise.all(ids.map((claimId) => change({ ...context, operation: "claim", claimId })));
      expect(claims.filter((r) => r.ok)).toHaveLength(1);
      expect(claims.find((r) => !r.ok)).toMatchObject({ status: 409 });
      const claimId = (await read(itemId)).claim!.id;
      expect(await change({ ...context, operation: "claim", claimId })).toMatchObject({ ok: true });
      // Items carry the hydrated claim with the holder's name so boards and details can show who is on it.
      expect((await get({ id: itemId }))?.claim).toEqual({
        id: claimId,
        actor,
        claimedAt: expect.any(String),
        displayName: "Task worker",
        avatarHash: null,
      });
      const claimedOnly = await listFiltered({ spaceId, filter: ItemFilterSchema.parse({ type: "task", activity: "claimed" }) });
      expect(claimedOnly.items.map((item) => [item.id, item.claim?.id])).toEqual([[itemId, claimId]]);
      expect(await change({ ...context, operation: "progress", content: "Wrong worker" })).toMatchObject({ ok: false, status: 409 });
      expect(
        await change({ ...context, operation: "progress", claimId, content: "Implemented; next run should verify race behavior." }),
      ).toMatchObject({ ok: true });
      expect((await read(itemId)).progress?.actor).toEqual(actor);
      expect(await setCompleted({ id: itemId, completed: true, actor })).toMatchObject({ ok: false, status: 409 });
      expect(await move({ id: itemId, columnId: columns[1]!.id, rank: "1024", completed: true, actor })).toMatchObject({
        ok: false,
        status: 409,
      });
      // A take-over names the exact claim it saw; any other claim ID is refused.
      expect(await change({ ...context, operation: "release", claimId: crypto.randomUUID(), force: true })).toMatchObject({ status: 409 });

      // A DB failure after updating the item must roll back completion AND preserve the claim/result.
      await sql`ALTER TABLE spaces.task_work ADD CONSTRAINT agent_test_reject_result CHECK (result->>'content' IS DISTINCT FROM 'reject-result')`;
      try {
        await expect(setCompleted({ id: itemId, completed: true, result: "reject-result", claimId, actor })).rejects.toThrow();
        expect((await get({ id: itemId }))?.completedAt).toBeNull();
        expect((await read(itemId)).claim?.id).toBe(claimId);
        expect((await read(itemId)).result).toBeNull();
      } finally {
        await sql`ALTER TABLE spaces.task_work DROP CONSTRAINT agent_test_reject_result`;
      }
      const completed = await setCompleted({
        id: itemId,
        completed: true,
        result: "Verified concurrent claims and rollback.",
        commit: "a1b2c3d",
        claimId,
        actor,
      });
      expect(completed.ok).toBe(true);
      expect(await read(itemId)).toMatchObject({
        claim: null,
        result: { content: "Verified concurrent claims and rollback.", commit: "a1b2c3d", actor },
      });
      expect((await setCompleted({ id: itemId, completed: false, actor })).ok).toBe(true);
      expect((await read(itemId)).result?.commit).toBe("a1b2c3d");
      const recoveryId = crypto.randomUUID();
      expect((await change({ ...context, operation: "claim", claimId: recoveryId })).ok).toBe(true);
      // Dragging an own claimed task into a done column completes it and releases the claim in one step.
      expect(await move({ id: itemId, columnId: columns[1]!.id, rank: "1024", completed: true, actor })).toMatchObject({ status: 409 });
      const moved = await move({ id: itemId, columnId: columns[1]!.id, rank: "1024", completed: true, claimId: recoveryId, actor });
      expect(moved.ok && moved.data.completedAt !== null && moved.data.claim === null).toBe(true);
      expect((await setCompleted({ id: itemId, completed: false, actor })).ok).toBe(true);
      expect((await move({ id: itemId, columnId: columns[0]!.id, rank: "1024", actor })).ok).toBe(true);
      expect(await listFiltered({ spaceId, filter: ItemFilterSchema.parse({ type: "task", activity: "claimed" }) })).toMatchObject({
        items: [],
      });
      expect((await change({ ...context, operation: "claim", claimId: recoveryId })).ok).toBe(true);
      expect((await change({ ...context, operation: "release", claimId: recoveryId, force: true })).ok).toBe(true);
      expect((await read(itemId)).claim).toBeNull();
      expect(await setCompleted({ id: itemId, completed: true, expectedSpaceId: crypto.randomUUID(), actor })).toMatchObject({
        status: 409,
      });
      expect(await change({ ...context, operation: "progress", content: "x".repeat(5001) })).toMatchObject({ status: 400 });

      expect(await setCompleted({ id: itemId, completed: true, commit: "a1b2c3d", actor })).toMatchObject({ status: 400 });
      expect(await setCompleted({ id: itemId, completed: true, result: "x".repeat(5001), actor })).toMatchObject({ status: 400 });
      await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${grant!.id}::uuid`;
      expect(await change({ ...context, operation: "progress", content: "Not allowed" })).toMatchObject({ status: 403 });
      await sql`UPDATE auth.access SET permission = 'write' WHERE id = ${grant!.id}::uuid`;
      expect(await change({ ...context, spaceId: crypto.randomUUID(), operation: "claim", claimId: crypto.randomUUID() })).toMatchObject({
        status: 403,
      });

      const [blocker] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[0]!.id}::uuid, 'Prerequisite') RETURNING id`;
      expect((await dependencies.add({ itemId, spaceId, blockerItemId: blocker!.id })).ok).toBe(true);
      expect(await change({ ...context, operation: "claim", claimId: crypto.randomUUID() })).toMatchObject({ status: 409 });
      expect(await setCompleted({ id: itemId, completed: true, result: "Must not save", actor })).toMatchObject({ status: 409 });
      expect(await move({ id: itemId, columnId: columns[1]!.id, rank: "2048", completed: true, actor })).toMatchObject({ status: 409 });
      expect((await read(itemId)).result?.content).toBe("Verified concurrent claims and rollback.");
      const blocked = await listFiltered({ spaceId, filter: ItemFilterSchema.parse({ type: "task", blocked: true }) });
      const ready = await listFiltered({ spaceId, filter: ItemFilterSchema.parse({ type: "task", blocked: false }) });
      expect(blocked.items.map((item) => item.id)).toEqual([itemId]);
      expect(ready.items.map((item) => item.id)).toEqual([blocker!.id]);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${grant!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${actor.id}::uuid`;
    }
  });

  test("a claim guards completion, not column moves, and any writer can take it over", async () => {
    const [space] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Claimed moves') RETURNING id`;
    const spaceId = space!.id;
    const accounts = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Holder', 'resource_bound', 'spaces', 'space', ${spaceId}), ('Colleague', 'resource_bound', 'spaces', 'space', ${spaceId}),
             ('Reader', 'resource_bound', 'spaces', 'space', ${spaceId})
      RETURNING id`;
    const [holder, colleague, reader] = accounts.map((row) => ({ kind: "service_account" as const, id: row.id }));
    const grants = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
      VALUES (${holder!.id}::uuid, 'write'), (${colleague!.id}::uuid, 'write'), (${reader!.id}::uuid, 'read') RETURNING id`;
    for (const grant of grants)
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${grant.id}::uuid)`;
    const as = (actor: typeof holder) => ({ actor: actor!, subject: { type: "service_account" as const, serviceAccountId: actor!.id } });
    try {
      const [todo, doing, review, done, archived] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, 'Todo', 1024, false), (${newShortId()}, ${spaceId}::uuid, 'Doing', 2048, false),
               (${newShortId()}, ${spaceId}::uuid, 'Review', 3072, false), (${newShortId()}, ${spaceId}::uuid, 'Done', 4096, true),
               (${newShortId()}, ${spaceId}::uuid, 'Archived', 5120, true)
        RETURNING id`;
      const [task] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${todo!.id}::uuid, 'Claimed task') RETURNING id`;
      const itemId = task!.id;
      const takeOvers = () => sql<{ actor_id: string; metadata: { from: { id: string }; fromName: string } }[]>`
        SELECT actor_id, metadata FROM spaces.activity_events WHERE item_id = ${itemId}::uuid AND action = 'task.taken_over' ORDER BY id`;
      const claimId = crypto.randomUUID();
      expect((await change({ itemId, spaceId, ...as(holder), operation: "claim", claimId })).ok).toBe(true);

      // A move that keeps the completion state needs no claim, for the holder or anyone else, and keeps the claim.
      expect((await move({ id: itemId, columnId: doing!.id, completed: false, actor: holder })).ok).toBe(true);
      expect((await move({ id: itemId, columnId: review!.id, completed: false, actor: colleague })).ok).toBe(true);
      expect((await move({ id: itemId, columnId: todo!.id, actor: colleague })).ok).toBe(true);
      expect((await setCompleted({ id: itemId, completed: false, actor: colleague })).ok).toBe(true);
      expect((await read(itemId)).claim?.id).toBe(claimId);

      // Completing needs the holder's claim ID or an explicit take-over of that exact claim.
      expect(await move({ id: itemId, columnId: done!.id, completed: true, actor: colleague })).toMatchObject({ ok: false, status: 409 });
      expect(await setCompleted({ id: itemId, completed: true, actor: colleague })).toMatchObject({ ok: false, status: 409 });
      expect(await move({ id: itemId, columnId: done!.id, completed: true, actor: holder })).toMatchObject({ ok: false, status: 409 });
      expect(
        await move({ id: itemId, columnId: done!.id, completed: true, claimId: crypto.randomUUID(), force: true, actor: colleague }),
      ).toMatchObject({ ok: false, status: 409, error: "Task claim changed; read its current state before taking it over" });
      expect((await get({ id: itemId }))?.completedAt).toBeNull();
      const completed = await move({ id: itemId, columnId: done!.id, completed: true, claimId, actor: holder });
      expect(completed.ok && completed.data.completedAt !== null && completed.data.claim === null).toBe(true);
      const completedAt = completed.ok ? completed.data.completedAt : null;
      // A claim-bound call after the claim ended is refused, even when it would change nothing.
      expect(await setCompleted({ id: itemId, completed: true, claimId, actor: holder })).toMatchObject({
        status: 409,
        error: "Task claim is no longer active",
      });

      // Between done statuses the completion time stays.
      const archivedMove = await move({ id: itemId, columnId: archived!.id, completed: true, actor: colleague });
      expect(archivedMove.ok && archivedMove.data.completedAt).toBe(completedAt);
      const reopened = await move({ id: itemId, columnId: doing!.id, completed: false, actor: holder });
      expect(reopened.ok && reopened.data.completedAt).toBeNull();
      expect(await takeOvers()).toEqual([]);

      // Any writer takes a claim over and completes in one step; the activity names who took it from whom.
      const second = crypto.randomUUID();
      expect((await change({ itemId, spaceId, ...as(holder), operation: "claim", claimId: second })).ok).toBe(true);
      const takenOver = await move({ id: itemId, columnId: done!.id, completed: true, claimId: second, force: true, actor: colleague });
      expect(takenOver.ok && takenOver.data.completedAt !== null && takenOver.data.claim === null).toBe(true);
      expect(await takeOvers()).toEqual([
        { actor_id: colleague!.id, metadata: expect.objectContaining({ from: holder, fromName: "Holder" }) },
      ]);
      // The holder's next claim-bound call learns that its claim ended.
      expect(await change({ itemId, spaceId, ...as(holder), operation: "progress", claimId: second, content: "Late" })).toMatchObject({
        status: 409,
        error: "Task claim is no longer active",
      });

      // A take-over by release ends the claim the same way, and the new worker claims it.
      expect((await setCompleted({ id: itemId, completed: false, actor: colleague })).ok).toBe(true);
      const third = crypto.randomUUID();
      expect((await change({ itemId, spaceId, ...as(holder), operation: "claim", claimId: third })).ok).toBe(true);
      // A read-only member takes nothing over.
      expect(await change({ itemId, spaceId, ...as(reader), operation: "release", claimId: third, force: true })).toMatchObject({
        status: 403,
      });
      expect((await change({ itemId, spaceId, ...as(colleague), operation: "release", claimId: third, force: true })).ok).toBe(true);
      expect((await change({ itemId, spaceId, ...as(colleague), operation: "claim", claimId: crypto.randomUUID() })).ok).toBe(true);
      expect((await read(itemId)).claim?.actor).toEqual(colleague);
      expect((await takeOvers()).map((row) => row.actor_id)).toEqual([colleague!.id, colleague!.id]);
      // The holder completes its own claim with its claim ID, by setCompleted as well.
      const own = await setCompleted({ id: itemId, completed: true, claimId: (await read(itemId)).claim!.id, actor: colleague });
      expect(own.ok && own.data.claim === null).toBe(true);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.id}::uuid`;
      for (const account of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
  });

  test("comment pages preserve all handoff notes beyond the newest fifty", async () => {
    const [space] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Comment pagination') RETURNING id`;
    try {
      const [column] = await sql<
        { id: string }[]
      >`INSERT INTO spaces.columns (short_id, space_id, name) VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
      const [task] = await sql<
        { id: string }[]
      >`INSERT INTO spaces.items (short_id, space_id, column_id, title) VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Handoff') RETURNING id`;
      for (let index = 0; index < 63; index++) {
        await sql`INSERT INTO spaces.comments (short_id, item_id, content, created_at) VALUES (${newShortId()}, ${task!.id}::uuid, ${`Note ${index}`}, ${new Date(1_700_000_000_000 + index * 1000)})`;
      }
      const first = await comments.list({ itemId: task!.id, pagination: { page: 1, perPage: 50 } });
      const second = await comments.list({ itemId: task!.id, pagination: { page: 2, perPage: 50 } });
      expect(first).toMatchObject({ total: 63, hasNext: true });
      expect(second).toMatchObject({ total: 63, hasNext: false });
      expect(new Set([...first.items, ...second.items].map((entry) => entry.content)).size).toBe(63);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    }
  });
});
