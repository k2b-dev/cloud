import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { CreateItemTemplateSchema, ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import type { WorkActor } from "../work-contracts";
import * as templates from "./item-templates";
import { create, get, listAssignableUsers, listFiltered, setAssignees, update } from "./items";
import { change, read } from "./task-work";
import * as wormholes from "./wormholes";

const suite = databaseSuite();
const denied = { ok: false, status: 400, error: "Assignee must have access to this space" } as const;
const claimed = { ok: false, status: 409 } as const;

type AccountKind = "agent" | "standalone" | "resource_bound" | "user_delegated";

const withFixture = async (run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) => {
  const spaceIds = [crypto.randomUUID(), crypto.randomUUID()];
  const userId = crypto.randomUUID();
  const accountIds: string[] = [];
  const accessIds: string[] = [];
  try {
    await run(await createFixture(spaceIds, userId, accountIds, accessIds));
  } finally {
    for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
    for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
};

const createFixture = async (spaceIds: string[], userId: string, accountIds: string[], accessIds: string[]) => {
  const spaceId = spaceIds[0]!;
  const destinationId = spaceIds[1]!;
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
    VALUES (${userId}::uuid, ${`agent-assignees-${userId}`}, 'local', 'user', 'Writer')`;
  for (const id of spaceIds) {
    await sql`INSERT INTO spaces.spaces (id, short_id, name) VALUES (${id}::uuid, ${newShortId()}, 'Agent assignments')`;
  }
  const grant = async (targetId: string, principalId: string | null, person = false) => {
    const id = crypto.randomUUID();
    accessIds.push(id);
    await sql`INSERT INTO auth.access (id, user_id, service_account_id, authenticated_only, permission)
      VALUES (${id}::uuid, ${person ? principalId : null}::uuid, ${person ? null : principalId}::uuid,
        ${principalId === null}, ${person ? "admin" : "write"})`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${targetId}::uuid, ${id}::uuid)`;
    return id;
  };
  await grant(spaceId, userId, true);
  await grant(destinationId, userId, true);
  const columns: string[] = [];
  for (const id of spaceIds) {
    const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
      VALUES (${newShortId()}, ${id}::uuid, 'Open', 1024) RETURNING id`;
    columns.push(column!.id);
  }
  const account = async (kind: AccountKind = "agent", options: { grant?: boolean; disabled?: boolean; boundSpaceId?: string } = {}) => {
    const id = crypto.randomUUID();
    accountIds.push(id);
    const name = `Assignment ${kind} ${id}`;
    await sql`INSERT INTO auth.service_accounts (id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id)
      VALUES (${id}::uuid, ${name}, ${kind}, ${options.disabled ? "disabled" : "active"},
        ${kind === "user_delegated" ? userId : null}::uuid, ${kind === "resource_bound" ? "spaces" : null},
        ${kind === "resource_bound" ? "space" : null}, ${kind === "resource_bound" ? (options.boundSpaceId ?? spaceId) : null})`;
    const accessId = options.grant === false ? null : await grant(spaceId, id);
    return { id, name, accessId, actor: { kind: "service_account" as const, id } };
  };
  const agent = await account();
  const person: WorkActor = { kind: "user", id: userId };
  const task = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
      VALUES (${newShortId()}, ${spaceId}::uuid, ${columns[0]}::uuid, 'Agent task') RETURNING id`;
    return row!.id;
  };
  const context = (itemId: string, actor: WorkActor = agent.actor) => ({
    itemId,
    spaceId,
    actor,
    subject:
      actor.kind === "user"
        ? { type: "user" as const, userId: actor.id, groupIds: [] }
        : { type: "service_account" as const, serviceAccountId: actor.id },
  });
  const claim = async (itemId: string) => {
    const claimId = crypto.randomUUID();
    expect(await change({ ...context(itemId), operation: "claim", claimId })).toMatchObject({ ok: true });
    return claimId;
  };
  return {
    spaceId,
    destinationId,
    columnId: columns[0]!,
    destinationColumnId: columns[1]!,
    userId,
    person,
    agent,
    account,
    grant,
    task,
    context,
    claim,
  };
};

suite("Spaces service-account assignees", () => {
  test("an exact account name lists first, and kind keeps people from crowding out accounts", async () => {
    await withFixture(async (f) => {
      // "Assignment ..." sorts before "Writer", even when the person could fill the only slot.
      expect(await listAssignableUsers({ spaceId: f.spaceId, limit: 1 })).toMatchObject([{ kind: "service_account" }]);
      const suffix = crypto.randomUUID();
      const exact = await f.account("agent");
      const longer = await f.account("standalone");
      await sql`UPDATE auth.service_accounts SET name = ${`Sync ${suffix}`} WHERE id = ${exact.id}::uuid`;
      // Sorts before the exact name and contains it, so only the exact-match order puts the exact one first.
      await sql`UPDATE auth.service_accounts SET name = ${`A Sync ${suffix} helper`} WHERE id = ${longer.id}::uuid`;
      const search = `SYNC ${suffix}`;
      expect(await listAssignableUsers({ spaceId: f.spaceId, search, kind: "service_account", limit: 1 })).toMatchObject([
        { id: exact.id },
      ]);
      expect((await listAssignableUsers({ spaceId: f.spaceId, search, kind: "service_account" })).map((entry) => entry.id)).toEqual([
        exact.id,
        longer.id,
      ]);
      const people = await listAssignableUsers({ spaceId: f.spaceId, kind: "user" });
      expect(people.length).toBeGreaterThan(0);
      expect(people.every((entry) => entry.kind === "user")).toBe(true);
      const accounts = await listAssignableUsers({ spaceId: f.spaceId, kind: "service_account" });
      expect(accounts.map((entry) => entry.id)).toContain(f.agent.id);
      expect(accounts.every((entry) => entry.kind === "service_account")).toBe(true);
    });
  });

  test("a claim assigns the account however it got write access", async () => {
    await withFixture(async (f) => {
      const outsider = await f.account("standalone", { grant: false });
      await f.grant(f.spaceId, null);
      const itemId = await f.task();
      expect(await change({ ...f.context(itemId, outsider.actor), operation: "claim", claimId: crypto.randomUUID() })).toMatchObject({
        ok: true,
      });
      expect((await get({ id: itemId }))?.assignees).toContainEqual(expect.objectContaining({ id: outsider.id, kind: "service_account" }));
      expect(await listAssignableUsers({ spaceId: f.spaceId, search: outsider.name })).not.toContainEqual(
        expect.objectContaining({ id: outsider.id }),
      );
    });
  });

  test("claiming assigns the agent once and assignment filters preserve personal scope", async () => {
    await withFixture(async (f) => {
      const itemId = await f.task();
      const claimId = await f.claim(itemId);
      expect(await change({ ...f.context(itemId), operation: "claim", claimId })).toMatchObject({ ok: true });
      expect((await get({ id: itemId }))?.assignees).toEqual([
        { id: f.agent.id, kind: "service_account", displayName: f.agent.name, avatarHash: null },
      ]);
      const filtered = async (values: Record<string, unknown>) =>
        (
          await listFiltered({ spaceId: f.spaceId, currentUserId: f.userId, filter: ItemFilterSchema.parse({ type: "task", ...values }) })
        ).items.map((item) => item.id);
      expect(await filtered({ assignedTo: "unassigned" })).toEqual([]);
      expect(await filtered({ assignedTo: "assigned" })).toEqual([itemId]);
      expect(await filtered({ assigneeIds: [f.agent.id] })).toEqual([itemId]);
      expect(await filtered({ assignedTo: "me" })).toEqual([]);
    });
  });

  for (const method of ["update", "setAssignees"] as const) {
    for (const force of [false, true]) {
      test(`${method} removes the agent and ends its claim (another writer=${force})`, async () => {
        await withFixture(async (f) => {
          const itemId = await f.task();
          const claimId = await f.claim(itemId);
          const actor = force ? f.person : f.agent.actor;
          const replace = (claimId?: string, force?: boolean) =>
            method === "update"
              ? update({ id: itemId, data: { assigneeIds: [], claimId, force }, actor })
              : setAssignees({ id: itemId, userIds: [], claimId, force, actor });
          expect(await replace()).toMatchObject(claimed);
          expect((await read(itemId)).claim?.id).toBe(claimId);
          expect((await get({ id: itemId }))?.assignees?.map((assignee) => assignee.id)).toEqual([f.agent.id]);
          expect(await replace(claimId, force)).toMatchObject({ ok: true });
          expect((await read(itemId)).claim).toBeNull();
          expect((await get({ id: itemId }))?.assignees).toEqual([]);
          const events = await sql<{ actor_id: string; metadata: unknown }[]>`
            SELECT actor_id, metadata FROM spaces.activity_events WHERE item_id = ${itemId}::uuid AND action = 'task.taken_over'`;
          expect(events).toEqual(
            force ? [{ actor_id: f.userId, metadata: expect.objectContaining({ from: f.agent.actor, fromName: f.agent.name }) }] : [],
          );
        });
      });
    }
  }

  test("releasing its own claim keeps the service-account assignment", async () => {
    await withFixture(async (f) => {
      const itemId = await f.task();
      const claimId = await f.claim(itemId);
      expect(await change({ ...f.context(itemId), operation: "release", claimId })).toMatchObject({ ok: true });
      expect((await read(itemId)).claim).toBeNull();
      expect((await get({ id: itemId }))?.assignees).toMatchObject([{ id: f.agent.id, kind: "service_account" }]);
    });
  });

  test("forced release of an agent's claim removes its assignment", async () => {
    await withFixture(async (f) => {
      const itemId = await f.task();
      const claimId = await f.claim(itemId);
      expect(await change({ ...f.context(itemId, f.person), operation: "release", claimId, force: true })).toMatchObject({ ok: true });
      expect((await read(itemId)).claim).toBeNull();
      expect((await get({ id: itemId }))?.assignees).toEqual([]);
    });
  });

  test("assignment uses direct grants, active status and exact resource binding on every write path", async () => {
    await withFixture(async (f) => {
      // Broad authenticated access makes no service account assignable without its own grant.
      await f.grant(f.spaceId, null);
      const invalid = [
        await f.account("agent", { grant: false }),
        await f.account("agent", { disabled: true }),
        await f.account("user_delegated"),
        await f.account("resource_bound", { boundSpaceId: f.destinationId }),
      ];
      const standalone = await f.account("standalone");
      const bound = await f.account("resource_bound");
      const listed = await listAssignableUsers({ spaceId: f.spaceId });
      for (const account of [f.agent, standalone, bound]) {
        expect(listed).toContainEqual(
          expect.objectContaining({ id: account.id, kind: "service_account", displayName: account.name, uid: account.name }),
        );
      }
      for (const account of invalid) expect(listed.some((entry) => entry.id === account.id)).toBe(false);
      expect(listed).toContainEqual(expect.objectContaining({ id: f.userId, kind: "user" }));
      expect(await listAssignableUsers({ spaceId: f.spaceId, search: f.agent.name.toUpperCase() })).toMatchObject([{ id: f.agent.id }]);
      expect(await listAssignableUsers({ spaceId: f.spaceId, search: f.agent.name, excludeUserIds: [f.agent.id] })).toEqual([]);
      const itemId = await f.task();
      const template = await templates.create({
        spaceId: f.spaceId,
        createdBy: f.userId,
        data: CreateItemTemplateSchema.parse({ kind: "task", name: "Valid agent", assigneeIds: [f.agent.id] }),
      });
      expect(template.ok).toBe(true);
      if (!template.ok) throw new Error(template.error);
      expect(template.data.assignees).toMatchObject([{ id: f.agent.id, kind: "service_account", displayName: f.agent.name }]);
      for (const account of invalid) {
        expect(
          await create({
            spaceId: f.spaceId,
            createdBy: f.userId,
            actor: f.person,
            data: { columnId: f.columnId, title: "Invalid", assigneeIds: [account.id] },
          }),
        ).toEqual(denied);
        expect(await update({ id: itemId, actor: f.person, data: { assigneeIds: [account.id] } })).toEqual(denied);
        expect(await setAssignees({ id: itemId, actor: f.person, userIds: [account.id] })).toEqual(denied);
        expect(
          await templates.create({
            spaceId: f.spaceId,
            createdBy: f.userId,
            data: CreateItemTemplateSchema.parse({ kind: "task", name: "Invalid", assigneeIds: [account.id] }),
          }),
        ).toEqual(denied);
        expect(await templates.update({ id: template.data.id, data: { assigneeIds: [account.id] } })).toEqual(denied);
      }
      // Stored defaults disappear from every template read when their own access disappears, and return if it is restored.
      await sql`DELETE FROM auth.access WHERE id = ${f.agent.accessId}::uuid`;
      expect((await templates.get({ id: template.data.id }))?.assignees).toEqual([]);
      await f.grant(f.spaceId, f.agent.id);
      expect((await templates.get({ id: template.data.id }))?.assignees).toMatchObject([{ id: f.agent.id, kind: "service_account" }]);
    });
  });

  test("standalone and matching resource-bound accounts can be explicitly assigned and used as template defaults", async () => {
    await withFixture(async (f) => {
      const standalone = await f.account("standalone");
      const bound = await f.account("resource_bound");
      // Assignment needs only read access; the writer performs the mutation.
      await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${standalone.accessId}::uuid`;
      const ids = [standalone.id, bound.id];
      const created = await create({
        spaceId: f.spaceId,
        createdBy: f.userId,
        actor: f.person,
        data: { columnId: f.columnId, title: "Assigned accounts", assigneeIds: ids },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      expect(created.data.assignees?.map((entry) => [entry.kind, entry.id])).toEqual([
        ["service_account", bound.id],
        ["service_account", standalone.id],
      ]);
      expect(await update({ id: created.data.id, actor: f.person, data: { assigneeIds: [bound.id] } })).toMatchObject({ ok: true });
      expect(await setAssignees({ id: created.data.id, actor: f.person, userIds: ids })).toMatchObject({ ok: true });
      const template = await templates.create({
        spaceId: f.spaceId,
        createdBy: f.userId,
        data: CreateItemTemplateSchema.parse({ kind: "task", name: "Account defaults", assigneeIds: ids }),
      });
      expect(template.ok).toBe(true);
      if (!template.ok) throw new Error(template.error);
      expect(template.data.assignees.map((entry) => [entry.kind, entry.id])).toEqual([
        ["service_account", bound.id],
        ["service_account", standalone.id],
      ]);
      const destinationBound = await f.account("resource_bound", { grant: false, boundSpaceId: f.destinationId });
      await f.grant(f.destinationId, destinationBound.id);
      expect(await listAssignableUsers({ spaceId: f.destinationId })).toContainEqual(
        expect.objectContaining({ id: destinationBound.id, kind: "service_account" }),
      );
      expect(
        await create({
          spaceId: f.destinationId,
          createdBy: f.userId,
          actor: f.person,
          data: { columnId: f.destinationColumnId, title: "Destination key", assigneeIds: [destinationBound.id] },
        }),
      ).toMatchObject({ ok: true });
    });
  });

  for (const loss of ["disabled", "ungranted"] as const) {
    test(`existing ${loss} accounts stay assigned, while new assignments need access`, async () => {
      await withFixture(async (f) => {
        await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${f.agent.accessId}::uuid`;
        const itemId = await f.task();
        expect(await setAssignees({ id: itemId, userIds: [f.agent.id], actor: f.person })).toMatchObject({ ok: true });
        const template = await templates.create({
          spaceId: f.spaceId,
          createdBy: f.userId,
          data: CreateItemTemplateSchema.parse({ kind: "task", name: "Read account", assigneeIds: [f.agent.id] }),
        });
        if (!template.ok) throw new Error(template.error);
        if (loss === "disabled") {
          await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${f.agent.id}::uuid`;
        } else {
          await sql`DELETE FROM auth.access WHERE id = ${f.agent.accessId}::uuid`;
        }
        expect(await update({ id: itemId, data: { assigneeIds: [f.agent.id, f.userId] }, actor: f.person })).toMatchObject({ ok: true });
        expect((await get({ id: itemId }))?.assignees).toContainEqual(expect.objectContaining({ id: f.agent.id, kind: "service_account" }));
        expect(await setAssignees({ id: itemId, userIds: [f.agent.id], actor: f.person })).toMatchObject({ ok: true });
        expect((await get({ id: itemId }))?.assignees).toMatchObject([{ id: f.agent.id, kind: "service_account" }]);
        expect((await templates.get({ id: template.data.id }))?.assignees).toEqual([]);

        const newItemId = await f.task();
        expect(await update({ id: newItemId, data: { assigneeIds: [f.agent.id] }, actor: f.person })).toEqual(denied);
        expect(await setAssignees({ id: newItemId, userIds: [f.agent.id], actor: f.person })).toEqual(denied);
      });
    });
  }

  for (const method of ["update", "setAssignees"] as const) {
    for (const holder of ["user_delegated", "deleted", "unassigned"] as const) {
      test(`${method} keeps a claim whose ${holder} holder is not an assignee`, async () => {
        await withFixture(async (f) => {
          const account = await f.account(holder === "user_delegated" ? "user_delegated" : "agent");
          const itemId = await f.task();
          const claimId = crypto.randomUUID();
          expect(await change({ ...f.context(itemId, account.actor), operation: "claim", claimId })).toMatchObject({ ok: true });
          if (holder === "deleted") {
            await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
          } else if (holder === "unassigned") {
            await sql`DELETE FROM spaces.item_assignees WHERE item_id = ${itemId}::uuid`;
          }
          expect((await get({ id: itemId }))?.assignees).toEqual([]);
          const result =
            method === "update"
              ? await update({ id: itemId, data: { assigneeIds: [f.userId] }, actor: f.person })
              : await setAssignees({ id: itemId, userIds: [f.userId], actor: f.person });
          expect(result).toMatchObject({ ok: true });
          expect((await get({ id: itemId }))?.assignees).toMatchObject([{ id: f.userId, kind: "user" }]);
          expect((await read(itemId)).claim).toMatchObject({ id: claimId, actor: account.actor });
          const events = await sql<{ action: string }[]>`
            SELECT action FROM spaces.activity_events WHERE item_id = ${itemId}::uuid AND action = 'task.taken_over'`;
          expect(events).toEqual([]);
        });
      });
    }
  }

  test("wormholes revalidate service accounts even when the destination grants broad access", async () => {
    await withFixture(async (f) => {
      const removed = await f.account();
      const boundToSource = await f.account("resource_bound");
      await f.grant(f.destinationId, f.agent.id);
      // Even its direct destination grant cannot make a source-bound key assignable there.
      await f.grant(f.destinationId, boundToSource.id);
      await f.grant(f.destinationId, null);
      const itemId = await f.task();
      expect(
        await setAssignees({ id: itemId, actor: f.person, userIds: [f.agent.id, removed.id, boundToSource.id, f.userId] }),
      ).toMatchObject({ ok: true });
      const actor = wormholes.actorForUser({ id: f.userId });
      const created = await wormholes.create({
        sourceSpaceId: f.spaceId,
        actor,
        data: { targetColumnId: f.destinationColumnId, color: "#6366f1" },
      });
      if (!created.ok) throw new Error(created.error);
      const result = await wormholes.transfer({ sourceSpaceId: f.spaceId, itemId, wormholeId: created.data.id, actor });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data.removedAssigneeCount).toBe(2);
      expect(result.data.item.assignees?.map((assignee) => [assignee.kind, assignee.id])).toEqual([
        ["service_account", f.agent.id],
        ["user", f.userId],
      ]);
    });
  });
});
