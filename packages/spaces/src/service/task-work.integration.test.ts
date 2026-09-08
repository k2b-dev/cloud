import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import * as comments from "./comments";
import * as dependencies from "./item-dependencies";
import { get, listFiltered, move, setCompleted } from "./items";
import { change, read } from "./task-work";

const [tables] = await sql<{ work: string | null }[]>`SELECT to_regclass('spaces.task_work')::text AS work`.catch(() => []);
const suite = tables?.work ? describe : describe.skip;

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
      expect(await change({ ...context, operation: "release", claimId: crypto.randomUUID(), force: true })).toMatchObject({ status: 403 });
      await sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${grant!.id}::uuid`;
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
