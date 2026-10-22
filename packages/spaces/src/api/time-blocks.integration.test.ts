import { afterEach, beforeAll, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { accounts, notifications, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { app } from "../config";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { createTimeBlockNotificationOutbox, type TimeBlockNotificationRow } from "../notifications";
import * as dependencies from "../service/item-dependencies";
import * as items from "../service/items";
import * as taskWork from "../service/task-work";
import { calendarTimeBlocks, myTimeBlocks, taskTimeBlocks } from "../service/time-block-views";
import * as blocks from "../service/time-blocks";
import * as wormholes from "../service/wormholes";
import { SpaceTimeBlockSchema } from "../time-block-contracts";
import api from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);
const from = "2030-03-14T09:00:00Z",
  to = "2030-03-14T10:00:00Z";
const data = () => ({ id: crypto.randomUUID(), startsAt: from, endsAt: to });
const spaceIds: string[] = [],
  userIds: string[] = [],
  accountIds: string[] = [];
afterEach(async () => {
  for (const id of spaceIds.splice(0)) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
  for (const id of accountIds.splice(0)) {
    await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
    await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
  }
  for (const id of userIds.splice(0)) {
    await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  }
  setSystemTime();
});

const scene = async () => {
  setSystemTime(new Date("2030-03-14T08:00:00Z"));
  const [space] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
    VALUES (${newShortId()}, 'Shared planning') RETURNING id, short_id`;
  spaceIds.push(space!.id);
  const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
    VALUES (${newShortId()}, ${space!.id}, 'Open', 1024) RETURNING id`;
  const [task] = await sql<
    { id: string; short_id: string }[]
  >`INSERT INTO spaces.items (short_id, space_id, column_id, title, estimated_duration_minutes)
    VALUES (${newShortId()}, ${space!.id}, ${column!.id}, 'Keep this a task', 90) RETURNING id, short_id`;
  const user = async (name: string, grant = true) => {
    const id = crypto.randomUUID();
    userIds.push(id);
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${id}::uuid, ${`${name}-${id}`}, 'local', 'user', ${name})`;
    if (grant) {
      const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${id}::uuid, 'read') RETURNING id`;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}, ${access!.id})`;
    }
    const loaded = await accounts.users.get({ id });
    if (!loaded) throw new Error("Missing fixture user");
    return { id, user: loaded, reader: blocks.readerForUser(loaded) };
  };
  const owner = await user("Owner"),
    colleague = await user("Colleague"),
    outsider = await user("Outsider", false);
  await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${task!.id}, ${owner.id})`;
  const tokenFor = async (person: typeof owner) => {
    const token = await serviceAccountCredentials.createUserApiToken({
      user: person.user,
      browserSignIn: await createTestBrowserSignIn(person.id),
      name: "time block test",
    });
    if (!token.ok) throw new Error(token.error.message);
    accountIds.push(token.data.credential.serviceAccountId);
    return token.data.token;
  };
  const request = async (person: typeof owner, path: string, method = "GET", body?: unknown) => {
    const token = await tokenFor(person);
    return api.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  return {
    space: space!,
    task: task!,
    column: column!,
    user,
    owner,
    colleague,
    outsider,
    request,
    itemPath: `/${space!.short_id}/items/${task!.short_id}/time-blocks`,
  };
};

suite("Shared task time blocks", () => {
  beforeAll(async () => {
    await migrate();
  });

  test("assigned read-only members plan their own time; other readers read; outsiders and unassigned writers cannot write", async () => {
    const f = await scene(),
      input = data();
    const created = await f.request(f.owner, f.itemPath, "POST", input);
    expect(created.status).toBe(200);
    const block = SpaceTimeBlockSchema.parse(await created.json());
    expect(block).toMatchObject({
      id: input.id,
      itemId: f.task.short_id,
      spaceId: f.space.short_id,
      title: "Keep this a task",
      ownerId: f.owner.id,
      taskState: "open",
      canWrite: true,
    });
    const other = await f.request(f.colleague, f.itemPath);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual([{ ...block, canWrite: false, canDelete: false }]);
    expect((await f.request(f.colleague, `/blocks/${block.id}`, "PATCH", { title: "Someone else's time" })).status).toBe(403);
    expect((await f.request(f.colleague, `/blocks/${block.id}`, "DELETE")).status).toBe(403);
    expect((await f.request(f.colleague, f.itemPath, "POST", data())).status).toBe(403);
    expect((await f.request(f.outsider, f.itemPath)).status).toBe(403);
    expect((await f.request(f.outsider, `/blocks/${block.id}`)).status).toBe(404);
    expect((await f.request(f.outsider, f.itemPath, "POST", data())).status).toBe(403);
    const listed = await f.request(f.owner, `/blocks?from=${from}&to=${to}&spaceId=${f.space.short_id}&mine=true&page=1&perPage=1`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [block], total: 1, page: 1, perPage: 1, hasNext: false });
    expect((await f.request(f.owner, "/blocks")).status).toBe(400);
    expect((await f.request(f.owner, `/blocks?from=${to}&to=${from}`)).status).toBe(400);
    expect((await f.request(f.owner, `/blocks?from=${from}&to=${to}&perPage=101`)).status).toBe(400);
  });

  test("calendar paging, item-only lists and task filters agree without leaking hidden task fields", async () => {
    const f = await scene(),
      first = data(),
      second = { ...data(), startsAt: to, endsAt: "2030-03-14T11:00:00Z" };
    await sql`UPDATE spaces.items SET priority = 'high' WHERE id = ${f.task.id}`;
    for (const input of [first, second])
      expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    const page = await blocks.list({ reader: f.colleague.reader, from, to: second.endsAt, page: 1, perPage: 1 });
    expect(page).toMatchObject({ ok: true, data: { items: [{ id: first.id }], total: 2, hasNext: true, page: 1 } });
    expect(await blocks.list({ reader: f.colleague.reader, from, to: second.endsAt, page: 2, perPage: 1 })).toMatchObject({
      ok: true,
      data: { items: [{ id: second.id }], total: 2, hasNext: false },
    });
    expect(await blocks.list({ reader: f.colleague.reader, from, to: second.endsAt, page: 3, perPage: 1 })).toMatchObject({
      ok: true,
      data: { items: [], total: 2, hasNext: false },
    });
    expect(await blocks.list({ reader: f.colleague.reader, from, to })).toMatchObject({
      ok: true,
      data: { items: [{ id: first.id }], total: 1 },
    });
    expect(await blocks.list({ reader: f.colleague.reader, from: to, to: second.endsAt })).toMatchObject({
      ok: true,
      data: { items: [{ id: second.id }], total: 1 },
    });
    expect(
      await blocks.list({
        reader: f.colleague.reader,
        from,
        to: second.endsAt,
        priorities: ["high"],
        assignedTo: "assigned",
        type: "task",
      }),
    ).toMatchObject({ ok: true, data: { total: 2 } });
    expect(await blocks.list({ reader: f.colleague.reader, from, to: second.endsAt, priorities: ["low"] })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
    expect(await blocks.list({ reader: f.colleague.reader, from, to: second.endsAt, assignedTo: "me" })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
    expect(await blocks.list({ reader: f.owner.reader, from, to: second.endsAt, type: "event" })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
    const itemOnly = await f.request(f.owner, `/blocks?itemId=${f.task.short_id}`);
    expect(itemOnly.status).toBe(200);
    expect(await itemOnly.json()).toMatchObject({ total: 2 });
    expect((await f.request(f.owner, `/blocks?from=${from}&to=${second.endsAt}&priorities=high&columnIds=${newShortId()}`)).status).toBe(
      400,
    );
    await sql`DELETE FROM spaces.space_access WHERE space_id = ${f.space.id}`;
    // The owner's saved block remains, but querying current private task fields must reveal nothing.
    for (const priorities of [["high"], ["low"]] as const)
      expect(await blocks.list({ reader: f.owner.reader, from, to: second.endsAt, priorities: [...priorities] })).toMatchObject({
        ok: true,
        data: { total: 0 },
      });
  });

  test("task-detail arrays opt into pagination above the public 100-row page size without limiting stored blocks", async () => {
    const f = await scene();
    await sql`INSERT INTO spaces.time_blocks (id, item_id, space_id, owner_id, title, starts_at, ends_at,
      creation_item_id, creation_owner_id, creation_starts_at, creation_ends_at)
      SELECT gen_random_uuid(), ${f.task.id}::uuid, ${f.space.id}::uuid, ${f.owner.id}::uuid, 'Planned time',
        ${from}::timestamptz, ${to}::timestamptz, ${f.task.id}::uuid, ${f.owner.id}::uuid, ${from}::timestamptz, ${to}::timestamptz
      FROM generate_series(1, 101)`;
    expect(await blocks.listForItem({ itemId: f.task.id, reader: f.owner.reader })).toMatchObject({ ok: false, error: { status: 400 } });
    const first = await blocks.listForItem({ itemId: f.task.id, reader: f.owner.reader, page: 1, perPage: 100 });
    const second = await blocks.listForItem({ itemId: f.task.id, reader: f.owner.reader, page: 2, perPage: 100 });
    expect(first.ok && first.data.length).toBe(100);
    expect(second.ok && second.data.length).toBe(1);
    expect((await f.request(f.owner, f.itemPath)).status).toBe(400);
    const apiPage = await f.request(f.owner, `${f.itemPath}?page=2&perPage=100`);
    expect(apiPage.status).toBe(200);
    expect(await apiPage.json()).toHaveLength(1);
    const counted = await f.request(f.owner, `/blocks?itemId=${f.task.short_id}&page=1&perPage=100`);
    expect(counted.status).toBe(200);
    expect(await counted.json()).toMatchObject({ total: 101, hasNext: true });
    expect(await taskTimeBlocks(f.task.id, f.owner.id)).toHaveLength(101);
  });

  test("deleted task blocks remain shared in their surviving Space even under task filters", async () => {
    const f = await scene(),
      input = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    expect((await items.remove({ id: f.task.id })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: {
        itemId: null,
        spaceId: f.space.short_id,
        spaceName: "Shared planning",
        taskState: "deleted",
        canWrite: false,
      },
    });
    expect(
      await blocks.list({
        reader: f.colleague.reader,
        from,
        to,
        spaceId: f.space.id,
        status: "completed",
        assignedTo: "unassigned",
        priorities: ["urgent"],
        columnIds: [crypto.randomUUID()],
        tagIds: [crypto.randomUUID()],
      }),
    ).toMatchObject({ ok: true, data: { total: 1, items: [{ id: input.id, taskState: "deleted" }] } });
    expect(await blocks.remove({ id: input.id, reader: f.colleague.reader })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await blocks.update({ id: input.id, reader: f.owner.reader, data: { title: "Deleted task" } })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await blocks.remove({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: true });
  });

  test("service authorization and paging cap scopes and resource-bound accounts, including direct callers", async () => {
    const f = await scene(),
      input = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    expect(await blocks.create({ itemId: f.task.id, reader: f.outsider.reader, data: data() })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const account = async (bound: boolean) => {
      const id = crypto.randomUUID();
      accountIds.push(id);
      await sql`INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id)
        VALUES (${id}::uuid, 'Block reader', ${bound ? "resource_bound" : "agent"}, ${bound ? "spaces" : null}, ${bound ? "space" : null}, ${bound ? f.space.id : null})`;
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (service_account_id, permission) VALUES (${id}::uuid, 'write') RETURNING id`;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${f.space.id}, ${grant!.id})`;
      const loaded = await serviceAccounts.get({ id });
      if (!loaded) throw new Error("Missing fixture account");
      const reader = (scopes: string[]): blocks.TimeBlockReader => ({
        actor: { kind: "service_account", serviceAccount: loaded, delegatedUser: null, scopes },
        subject: { type: "service_account", serviceAccountId: id },
      });
      return { id, reader };
    };
    const agent = await account(false),
      bound = await account(true);
    for (const credential of [agent, bound]) {
      expect(await blocks.get({ id: input.id, reader: credential.reader(["read"]) })).toMatchObject({
        ok: true,
        data: { canWrite: false },
      });
      expect(await blocks.get({ id: input.id, reader: credential.reader(["openid"]) })).toMatchObject({
        ok: false,
        error: { status: 404 },
      });
      expect(await blocks.list({ reader: credential.reader(["openid"]), from, to })).toMatchObject({ ok: true, data: { total: 0 } });
      expect(await blocks.create({ itemId: f.task.id, reader: credential.reader(["write"]), data: data() })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      expect(await blocks.update({ id: input.id, reader: credential.reader(["write"]), data: { title: "No" } })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
    }
    const [other] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Other') RETURNING id`;
    spaceIds.push(other!.id);
    // The account retains a grant, but its current binding is elsewhere.
    await sql`UPDATE auth.service_accounts SET resource_id = ${other!.id} WHERE id = ${bound.id}`;
    const reloaded = await serviceAccounts.get({ id: bound.id });
    if (!reloaded) throw new Error("Missing fixture account");
    const wrongBinding: blocks.TimeBlockReader = {
      actor: { kind: "service_account", serviceAccount: reloaded, delegatedUser: null, scopes: ["read", "write"] },
      subject: { type: "service_account", serviceAccountId: bound.id },
    };
    expect(await blocks.listForItem({ itemId: f.task.id, reader: wrongBinding })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await blocks.get({ id: input.id, reader: wrongBinding })).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await blocks.list({ reader: wrongBinding, from, to })).toMatchObject({ ok: true, data: { items: [], total: 0 } });
  });

  test("concurrent client retries create one block; input mismatch conflicts; title edits and stale approvals are safe", async () => {
    const f = await scene(),
      input = data();
    expect(
      await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input, expectedTaskTitle: "Stale reviewed title" }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM spaces.time_blocks WHERE item_id = ${f.task.id}`;
    expect(count?.count).toBe(1);
    expect(
      await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: { ...input, endsAt: "2030-03-14T11:00:00Z" } }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const initial = results[0]!;
    if (!initial.ok) throw new Error("Missing created block");
    const revision = blocks.revisionForTimeBlock(initial.data);
    expect(
      await blocks.update({ id: input.id, reader: f.owner.reader, data: { title: "My focus time" }, expectedRevision: revision }),
    ).toMatchObject({ ok: true, data: { title: "My focus time" } });
    expect(await blocks.remove({ id: input.id, reader: f.owner.reader, expectedRevision: revision })).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
    expect(await blocks.update({ id: input.id, reader: f.owner.reader, data: { startsAt: to } })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    expect(await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: { ...data(), endsAt: from } })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    // A retry compares immutable creation input, even after the owner has edited the block.
    expect(await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).toMatchObject({
      ok: true,
      data: { title: "My focus time" },
    });
    expect(await blocks.listForItem({ itemId: f.task.id, reader: f.owner.reader })).toMatchObject({ ok: true, data: [{ id: input.id }] });
    expect((await items.update({ id: f.task.id, data: { title: "Updated task title" } })).ok).toBe(true);
    expect(
      await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input, expectedTaskTitle: "Keep this a task" }),
    ).toMatchObject({ ok: true, data: { title: "My focus time" } });
  });

  test("planning leaves task estimates, claims and checklists unchanged; completion and reopening preserve the blocks", async () => {
    const f = await scene(),
      input = data();
    await sql`INSERT INTO spaces.item_checklist_entries (short_id, item_id, label) VALUES (${newShortId()}, ${f.task.id}, 'Keep checklist')`;
    const claim = { id: crypto.randomUUID(), actor: { kind: "user", id: f.owner.id }, claimedAt: "2030-03-14T08:00:00Z" };
    await sql`INSERT INTO spaces.task_work (item_id, claim) VALUES (${f.task.id}, ${claim}::jsonb)`;
    const before = await items.get({ id: f.task.id });
    const beforeWork = await sql`SELECT * FROM spaces.task_work WHERE item_id = ${f.task.id}`;
    const beforeChecklist = await sql`SELECT * FROM spaces.item_checklist_entries WHERE item_id = ${f.task.id}`;
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    expect(await items.get({ id: f.task.id })).toEqual(before);
    expect(await sql`SELECT * FROM spaces.task_work WHERE item_id = ${f.task.id}`).toEqual(beforeWork);
    expect(await sql`SELECT * FROM spaces.item_checklist_entries WHERE item_id = ${f.task.id}`).toEqual(beforeChecklist);
    expect(
      (await items.setCompleted({ id: f.task.id, completed: true, actor: { kind: "user", id: f.owner.id }, claimId: claim.id })).ok,
    ).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({
      ok: true,
      data: { taskState: "done", id: input.id },
    });
    expect((await items.setCompleted({ id: f.task.id, completed: false, actor: { kind: "user", id: f.owner.id } })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({
      ok: true,
      data: { taskState: "open", id: input.id },
    });
  });

  test("task and Space deletion preserve history and owner deletion; loss of task access redacts every task/Space reference", async () => {
    const f = await scene(),
      input = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    await sql`DELETE FROM spaces.space_access WHERE space_id = ${f.space.id}`;
    const redacted = { itemId: null, spaceId: null, spaceName: null, spaceColor: null, taskState: "no_access", canWrite: false };
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: true, data: redacted });
    expect(await blocks.list({ reader: f.owner.reader, from, to, mine: true })).toMatchObject({
      ok: true,
      data: { items: [redacted], total: 1 },
    });
    expect(await blocks.list({ reader: f.owner.reader, from, to, spaceId: f.space.id })).toMatchObject({ ok: true, data: { total: 0 } });
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await blocks.update({ id: input.id, reader: f.owner.reader, data: { title: "No" } })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect((await items.remove({ id: f.task.id })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({
      ok: true,
      data: { itemId: null, taskState: "deleted", canWrite: false, canDelete: true },
    });
    await sql`DELETE FROM spaces.spaces WHERE id = ${f.space.id}`;
    expect(await blocks.list({ reader: f.owner.reader, from, to, mine: true })).toMatchObject({
      ok: true,
      data: { total: 1, items: [{ id: input.id, spaceId: null, taskState: "deleted" }] },
    });
    expect((await blocks.remove({ id: input.id, reader: f.owner.reader })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: false, error: { status: 404 } });
    // A direct Space cascade also keeps the block, without needing a prior task delete.
    const second = await scene(),
      secondInput = data();
    expect((await blocks.create({ itemId: second.task.id, reader: second.owner.reader, data: secondInput })).ok).toBe(true);
    await sql`DELETE FROM spaces.spaces WHERE id = ${second.space.id}`;
    expect(await blocks.list({ reader: second.owner.reader, from, to, mine: true })).toMatchObject({
      ok: true,
      data: { total: 1, items: [{ id: secondInput.id, taskState: "deleted" }] },
    });
  });

  test("singleton reassignment transfers only removed owners and durably notifies BOTH people after commit with retry deduplication", async () => {
    const f = await scene(),
      input = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    const other = await f.user("Third person");
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT id FROM spaces.items WHERE id = ${f.task.id} FOR UPDATE`;
        await tx`DELETE FROM spaces.item_assignees WHERE item_id = ${f.task.id}`;
        await tx`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${f.task.id}, ${f.colleague.id})`;
        await blocks.reconcileAssignees(tx, f.task.id);
        // A separate observer cannot see ownership or effects until the domain transaction commits.
        expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: true, data: { ownerId: f.owner.id } });
        expect(
          await sql`SELECT id FROM spaces.time_block_notifications WHERE recipient_id IN (${f.owner.id}, ${f.colleague.id})`,
        ).toHaveLength(0);
        throw new Error("reject reassignment");
      }),
    ).rejects.toThrow("reject reassignment");
    expect(await sql`SELECT id FROM spaces.time_block_notifications WHERE recipient_id IN (${f.owner.id}, ${f.colleague.id})`).toHaveLength(
      0,
    );
    expect((await items.setAssignees({ id: f.task.id, userIds: [f.owner.id, f.colleague.id] })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: true, data: { ownerId: f.owner.id } });
    const colleagueInput = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.colleague.reader, data: colleagueInput })).ok).toBe(true);
    expect((await items.update({ id: f.task.id, data: { assigneeIds: [f.colleague.id] } })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: { ownerId: f.colleague.id, canWrite: true },
    });
    expect(await blocks.get({ id: colleagueInput.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: { ownerId: f.colleague.id },
    });
    expect(await blocks.update({ id: input.id, reader: f.owner.reader, data: { title: "No longer mine" } })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const pending = await sql<
      TimeBlockNotificationRow[]
    >`SELECT * FROM spaces.time_block_notifications WHERE recipient_id IN (${f.owner.id}, ${f.colleague.id}) ORDER BY seq`;
    expect(pending.map((row) => [row.recipient_id, row.direction])).toEqual([
      [f.owner.id, "released"],
      [f.colleague.id, "received"],
    ]);
    const outbox = createTimeBlockNotificationOutbox(app.notifications);
    const first = pending[0]!;
    await outbox.dispatch(first, async () => {
      throw new Error("temporary notification outage");
    });
    const [failed] = await sql`SELECT attempts, last_error FROM spaces.time_block_notifications WHERE id = ${first.id}`;
    expect(failed).toMatchObject({ attempts: 1, last_error: "temporary notification outage" });
    // Real Cloud sends use the outbox ID as stable key; repeated sends resolve to the same event.
    const send = () =>
      notifications.send(app.notifications.timeBlocksReassigned, {
        recipient: { userId: first.recipient_id },
        data: { direction: first.direction },
        idempotencyKey: first.id,
      });
    const firstSent = await send(),
      repeated = await send();
    expect(repeated.id).toBe(firstSent.id);
    const [retried] = await sql<TimeBlockNotificationRow[]>`SELECT * FROM spaces.time_block_notifications WHERE id = ${first.id}`;
    await outbox.dispatch(retried!);
    await outbox.dispatch(pending[1]!);
    expect(await sql`SELECT id FROM spaces.time_block_notifications WHERE id IN (${first.id}, ${pending[1]!.id})`).toHaveLength(0);
    const events = await sql<{ recipient_user_id: string }[]>`SELECT recipient_user_id FROM notifications.events
      WHERE definition_id = 'spaces.timeBlocksReassigned' AND recipient_user_id IN (${f.owner.id}, ${f.colleague.id})`;
    expect(events.map((event) => event.recipient_user_id).sort()).toEqual([f.owner.id, f.colleague.id].sort());
    // No arbitrary successor: retained until the unresolved product policy is decided.
    expect((await items.setAssignees({ id: f.task.id, userIds: [f.owner.id, other.id] })).ok).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: { ownerId: f.colleague.id, canWrite: false },
    });
  });
  test("dependency route and calendar task sources stay separate from time blocks", async () => {
    const f = await scene();
    const [dependent] = await sql<{ id: string; short_id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
      VALUES (${newShortId()}, ${f.space.id}, ${f.column.id}, 'Dependent task') RETURNING id, short_id`;
    expect((await dependencies.add({ itemId: dependent!.id, spaceId: f.space.id, blockerItemId: f.task.id })).ok).toBe(true);
    const oldRoute = `/${f.space.short_id}/items/${f.task.short_id}/blocks`;
    const before = await (await f.request(f.owner, oldRoute)).json();
    const input = data();
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    const after = await f.request(f.owner, oldRoute);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(before);
    expect(JSON.stringify(before)).toContain("Dependent task");
    expect(await items.listCalendar({ spaceId: f.space.id, subject: f.owner.reader.subject, from, to })).toHaveLength(0);
    expect(await calendarTimeBlocks({ userId: f.colleague.id, spaceId: f.space.id, from, to })).toMatchObject([
      { id: input.id, canWrite: false },
    ]);
  });

  test("My work includes own today and future blocks, completed and deleted history without calendar-year truncation", async () => {
    const f = await scene(),
      todayBlock = data();
    const futureBlock = { ...data(), startsAt: "2032-03-14T09:00:00Z", endsAt: "2032-03-14T10:00:00Z" };
    for (const input of [todayBlock, futureBlock])
      expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    const period = { today: "2030-03-14T00:00:00Z", tomorrow: "2030-03-15T00:00:00Z" };
    expect(await myTimeBlocks({ ...period, userId: f.owner.id, view: "today" })).toMatchObject({
      blocks: [{ id: todayBlock.id }],
      counts: { today: 1, upcoming: 1 },
    });
    expect(await myTimeBlocks({ ...period, userId: f.owner.id, view: "upcoming" })).toMatchObject({ blocks: [{ id: futureBlock.id }] });
    expect(await myTimeBlocks({ ...period, userId: f.colleague.id, view: "today" })).toMatchObject({
      blocks: [],
      counts: { today: 0, upcoming: 0 },
    });
    expect((await items.setCompleted({ id: f.task.id, completed: true, actor: { kind: "user", id: f.owner.id } })).ok).toBe(true);
    expect(await myTimeBlocks({ ...period, userId: f.owner.id, view: "today" })).toMatchObject({
      blocks: [{ id: todayBlock.id, taskState: "done" }],
    });
    await sql`DELETE FROM spaces.space_access WHERE space_id = ${f.space.id}`;
    expect(await myTimeBlocks({ ...period, userId: f.owner.id, view: "today" })).toMatchObject({
      blocks: [{ id: todayBlock.id, taskState: "no_access", spaceId: null, itemId: null }],
    });
    expect((await items.remove({ id: f.task.id })).ok).toBe(true);
    expect(await myTimeBlocks({ ...period, userId: f.owner.id, view: "today" })).toMatchObject({
      blocks: [{ id: todayBlock.id, taskState: "deleted" }],
    });
  });

  test("claim takeover reconciles blocks when removing the owner leaves one assigned person", async () => {
    const f = await scene(),
      input = data(),
      claimId = crypto.randomUUID();
    await sql`UPDATE auth.access SET permission = 'write' WHERE user_id IN (${f.owner.id}, ${f.colleague.id})`;
    expect((await items.setAssignees({ id: f.task.id, userIds: [f.owner.id, f.colleague.id] })).ok).toBe(true);
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    expect(
      (
        await taskWork.change({
          itemId: f.task.id,
          spaceId: f.space.id,
          actor: { kind: "user", id: f.owner.id },
          subject: f.owner.reader.subject,
          operation: "claim",
          claimId,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await taskWork.change({
          itemId: f.task.id,
          spaceId: f.space.id,
          actor: { kind: "user", id: f.colleague.id },
          subject: f.colleague.reader.subject,
          operation: "release",
          claimId,
          force: true,
        })
      ).ok,
    ).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: { ownerId: f.colleague.id, canWrite: true },
    });
    expect(await sql`SELECT id FROM spaces.time_block_notifications WHERE recipient_id IN (${f.owner.id}, ${f.colleague.id})`).toHaveLength(
      2,
    );
  });

  test("Space transfer moves block visibility and ownership with the surviving assignment", async () => {
    const f = await scene(),
      input = data();
    const [target] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Destination') RETURNING id, short_id`;
    spaceIds.push(target!.id);
    const [column] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${target!.id}, 'Open', 1024) RETURNING id`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (user_id, permission) VALUES (${f.colleague.id}, 'write') RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${target!.id}, ${grant!.id})`;
    await sql`UPDATE auth.access SET permission = 'write' WHERE user_id = ${f.colleague.id}`;
    const [hole] = await sql<
      { id: string }[]
    >`INSERT INTO spaces.wormholes (short_id, source_space_id, target_column_id, rank) VALUES (${newShortId()}, ${f.space.id}, ${column!.id}, 1024) RETURNING id`;
    expect((await items.setAssignees({ id: f.task.id, userIds: [f.owner.id, f.colleague.id] })).ok).toBe(true);
    expect((await blocks.create({ itemId: f.task.id, reader: f.owner.reader, data: input })).ok).toBe(true);
    expect(
      (
        await wormholes.transfer({
          sourceSpaceId: f.space.id,
          itemId: f.task.id,
          wormholeId: hole!.id,
          actor: wormholes.actorForUser(f.colleague.user),
          workActor: { kind: "user", id: f.colleague.id },
        })
      ).ok,
    ).toBe(true);
    expect(await blocks.get({ id: input.id, reader: f.colleague.reader })).toMatchObject({
      ok: true,
      data: { spaceId: target!.short_id, ownerId: f.colleague.id },
    });
    expect(await blocks.get({ id: input.id, reader: f.owner.reader })).toMatchObject({ ok: false, error: { status: 404 } });
    expect(await blocks.list({ reader: f.colleague.reader, from, to, spaceId: f.space.id })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
    expect(await blocks.list({ reader: f.colleague.reader, from, to, spaceId: target!.id })).toMatchObject({
      ok: true,
      data: { total: 1 },
    });
    expect(await sql`SELECT id FROM spaces.time_block_notifications WHERE recipient_id IN (${f.owner.id}, ${f.colleague.id})`).toHaveLength(
      2,
    );
  });
});
