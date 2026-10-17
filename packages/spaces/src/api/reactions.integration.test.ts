import { expect, setDefaultTimeout, test } from "bun:test";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import type { SpaceItem, SpaceItemReaction } from "../contracts";
import { newShortId } from "../lib/short-id";
import { spacesService } from "../service";
import * as reactions from "../service/reactions";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);
const emojiSet = [
  "😀",
  "😃",
  "😄",
  "😁",
  "😆",
  "😅",
  "😂",
  "🤣",
  "😊",
  "😇",
  "🙂",
  "🙃",
  "😉",
  "😌",
  "😍",
  "🥰",
  "😘",
  "😗",
  "😙",
  "😚",
  "😋",
  "😛",
  "😝",
  "😜",
  "🤪",
  "🤨",
  "🧐",
  "🤓",
  "😎",
  "🥸",
];
type Summary = { reactions: SpaceItemReaction[] };

const fixture = async (
  run: (f: {
    itemId: string;
    itemPath: string;
    spaceId: string;
    spaceShortId: string;
    users: { id: string; call: Call }[];
    agentId: string;
    agent: Call;
    bound: Call;
    reader: Call;
  }) => Promise<void>,
) => {
  const userIds: string[] = [];
  const accountIds: string[] = [];
  const accessIds: string[] = [];
  const [space] = await sql<{ id: string; short_id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Reaction tests') RETURNING id, short_id`;
  const callAs =
    (token: string): Call =>
    async (path, method = "GET", body) =>
      spacesApi.request(path, {
        method,
        // API tokens are rate-limited by client IP; without one, every test file shares the `ip:unknown` bucket and
        // the concurrent bursts here get 429s from unrelated traffic. A fresh address keeps each request on its own budget.
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  const grant = async (userId: string | null, accountId: string | null, permission: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, service_account_id, permission)
      VALUES (${userId}::uuid, ${accountId}::uuid, ${permission}) RETURNING id`;
    accessIds.push(row!.id);
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${row!.id}::uuid)`;
  };
  try {
    const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
      VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
    const [item] = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO spaces.items (short_id, space_id, column_id, title, created_at, updated_at)
      VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'React here', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z') RETURNING id, short_id`;
    const users = [];
    for (let i = 0; i < 6; i++) {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`reaction-${crypto.randomUUID()}`}, 'local', 'user', ${`Person ${i}`}) RETURNING id`;
      userIds.push(row!.id);
      await grant(row!.id, null, i === 5 ? "read" : "write");
      const user = await accounts.users.get({ id: row!.id });
      if (!user) throw new Error("Fixture user missing");
      const token = await serviceAccountCredentials.createUserApiToken({ user, name: "reactions test" });
      if (!token.ok) throw new Error(token.error.message);
      // User API credentials are delegated service accounts; clean them explicitly too.
      const credentials = await sql<{ service_account_id: string }[]>`SELECT service_account_id FROM auth.service_account_credentials
        WHERE service_account_id IN (SELECT id FROM auth.service_accounts WHERE delegated_user_id = ${row!.id}::uuid)`;
      accountIds.push(...credentials.map((c) => c.service_account_id));
      users.push({ id: row!.id, call: callAs(token.data.token) });
    }
    const account = async (bound: boolean) => {
      const [row] = bound
        ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
            VALUES ('Bound reactor', 'resource_bound', 'spaces', 'space', ${space!.id}) RETURNING id`
        : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES ('Reaction agent', 'agent') RETURNING id`;
      accountIds.push(row!.id);
      await grant(null, row!.id, "write");
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: row!.id,
        name: "reaction",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw new Error(token.error.message);
      return { id: row!.id, call: callAs(token.data.token) };
    };
    const agent = await account(false);
    const bound = await account(true);
    await run({
      itemId: item!.id,
      itemPath: `/${space!.short_id}/items/${item!.short_id}`,
      spaceId: space!.id,
      spaceShortId: space!.short_id,
      users,
      agentId: agent.id,
      agent: agent.call,
      bound: bound.call,
      reader: users[5]!.call,
    });
  } finally {
    await sql`DELETE FROM events.outbox WHERE app_id = 'spaces' AND ordering_key = ${space!.id}`;
    await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (accountIds.length) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN ${sql(accountIds)}`;
      await sql`DELETE FROM auth.access WHERE service_account_id IN ${sql(accountIds)}`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accountIds)}`;
    }
    if (userIds.length) {
      await sql`DELETE FROM audit.events WHERE actor_user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM auth.access WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
    }
  }
};
type Call = (path: string, method?: string, body?: unknown) => Promise<Response>;
const reactionPath = (path: string, emoji: string) => `${path}/reactions/${encodeURIComponent(emoji)}`;
const summary = async (response: Response): Promise<Summary> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Summary>;
};

suite("Spaces reactions", () => {
  test("idempotent own intents, bounded people, user and agent identity, reader access and decoded emoji", () =>
    fixture(async (f) => {
      const path = reactionPath(f.itemPath, "👍🏽");
      const first = f.users[0]!;
      expect((await summary(await first.call(path, "PUT"))).reactions[0]).toEqual({ emoji: "👍🏽", count: 1, own: true, people: [] });
      expect((await summary(await first.call(path, "PUT"))).reactions[0]?.count).toBe(1);
      const two = await summary(await f.users[1]!.call(path, "PUT"));
      expect(two.reactions[0]).toMatchObject({ count: 2, own: true, people: [{ kind: "user", id: first.id, displayName: "Person 0" }] });
      for (const user of f.users.slice(2, 5)) await summary(await user.call(path, "PUT"));
      for (const [index, user] of f.users.slice(0, 5).entries()) {
        await sql`UPDATE spaces.item_reactions SET created_at = ${`2026-10-0${index + 1}T08:00:00Z`}::timestamptz
          WHERE item_id = ${f.itemId} AND user_id = ${user.id}::uuid`;
      }
      const read = await f.reader(f.itemPath);
      expect(read.status).toBe(200);
      const item = (await read.json()) as SpaceItem;
      expect(item.reactions?.[0]).toMatchObject({ count: 5, own: false });
      expect(item.reactions?.[0]?.people.map((p) => p.id)).toEqual(f.users.slice(0, 3).map((u) => u.id));
      expect((await reactions.listForItem(f.itemId, { kind: "user", id: f.users[5]!.id }))[0]).toEqual(item.reactions?.[0]);
      const own = await summary(await first.call(path, "PUT"));
      expect(own.reactions[0]?.people.map((p) => p.id)).toEqual(f.users.slice(1, 4).map((u) => u.id));
      expect(own.reactions[0]?.people.some((p) => p.id === first.id)).toBe(false);
      for (const method of ["PUT", "DELETE"]) expect((await f.reader(path, method)).status).toBe(403);
      const filtered = await f.reader(`/${f.spaceShortId}/items/filter`, "POST", {});
      expect(filtered.status).toBe(200);
      expect(((await filtered.json()) as { items: SpaceItem[] }).items[0]?.reactions).toEqual(item.reactions);
      expect(((await (await f.reader(`/${f.spaceShortId}/items`)).json()) as SpaceItem[])[0]?.reactions).toEqual(item.reactions);
      const detail = await f.reader(`${f.itemPath}/detail`);
      expect(detail.status, await detail.clone().text()).toBe(200);
      expect(((await detail.json()) as { item: SpaceItem }).item.reactions).toEqual(item.reactions);
      const heart = reactionPath(f.itemPath, "❤️");
      expect((await summary(await f.agent(heart, "PUT"))).reactions.find((r) => r.emoji === "❤️")?.own).toBe(true);
      expect((await summary(await first.call(heart, "PUT"))).reactions.find((r) => r.emoji === "❤️")?.people).toEqual([
        { kind: "service_account", id: f.agentId, displayName: "Reaction agent" },
      ]);
      expect((await f.bound(path, "PUT")).status).toBe(403);
      expect((await summary(await first.call(heart, "DELETE"))).reactions.find((r) => r.emoji === "❤️")).toMatchObject({
        count: 1,
        own: false,
      });
      expect((await first.call(`${path}?recurrence_id=2026-10-17T10:00:00Z`, "PUT")).status).toBe(400);
      expect((await first.call(`/${f.spaceShortId}/items/${newShortId()}/reactions/${encodeURIComponent("👍")}`, "PUT")).status).toBe(404);
    }));

  test("order uses the oldest remaining reactor, not count; re-adding comes last", () =>
    fixture(async (f) => {
      const a = reactionPath(f.itemPath, "👍");
      const b = reactionPath(f.itemPath, "❤️");
      await summary(await f.users[0]!.call(a, "PUT"));
      await sql`UPDATE spaces.item_reactions SET created_at = '2026-10-01T08:00:00Z' WHERE item_id = ${f.itemId}`;
      await summary(await f.users[1]!.call(b, "PUT"));
      await sql`UPDATE spaces.item_reactions SET created_at = '2026-10-02T08:00:00Z' WHERE item_id = ${f.itemId} AND emoji = '❤️'`;
      await summary(await f.users[1]!.call(a, "PUT"));
      await sql`UPDATE spaces.item_reactions SET created_at = '2026-10-03T08:00:00Z' WHERE item_id = ${f.itemId} AND user_id = ${f.users[1]!.id} AND emoji = '👍'`;
      expect((await reactions.listForItem(f.itemId, { kind: "user", id: f.users[0]!.id })).map((r) => r.emoji)).toEqual(["👍", "❤️"]);
      expect((await summary(await f.users[0]!.call(a, "DELETE"))).reactions.map((r) => r.emoji)).toEqual(["❤️", "👍"]);
      await summary(await f.users[1]!.call(b, "DELETE"));
      await summary(await f.users[1]!.call(b, "PUT"));
      await sql`UPDATE spaces.item_reactions SET created_at = '2026-10-04T08:00:00Z' WHERE item_id = ${f.itemId} AND emoji = '❤️'`;
      expect((await reactions.listForItem(f.itemId, { kind: "user", id: f.users[0]!.id })).map((r) => r.emoji)).toEqual(["👍", "❤️"]);
    }));

  test.each(["user", "service_account"] as const)("a waiting %s add orders emoji after the lock holder's reaction", (kind) =>
    fixture(async (f) => {
      const actor = { kind, id: kind === "user" ? f.users[0]!.id : f.agentId };
      let pendingAdd: ReturnType<typeof reactions.add> | undefined;
      try {
        await sql.begin(async (tx) => {
          const [item] = await tx<{ pid: number }[]>`
            SELECT pg_backend_pid() AS pid FROM spaces.items WHERE id = ${f.itemId} FOR NO KEY UPDATE
          `;
          pendingAdd = reactions.add({ itemId: f.itemId, spaceId: f.spaceId, emoji: "👍", actor });
          const deadline = Date.now() + 5_000;
          while (true) {
            const [row] = await sql<{ blocked: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
                  AND ${item!.pid}::int = ANY(pg_blocking_pids(pid))
              ) AS blocked
            `;
            if (row?.blocked) break;
            if (Date.now() >= deadline) throw new Error("Reaction add did not wait for the item row lock within 5 seconds");
            await Bun.sleep(10);
          }
          // The waiting add's transaction started before B; now() would incorrectly put A first.
          await tx`
            INSERT INTO spaces.item_reactions (item_id, emoji, user_id, created_at)
            VALUES (${f.itemId}, '❤️', ${f.users[1]!.id}, clock_timestamp())
          `;
        });
        const result = await pendingAdd;
        if (!result?.ok) throw new Error("Expected the waiting reaction add to succeed");
        expect(result.data.reactions.map((reaction) => reaction.emoji)).toEqual(["❤️", "👍"]);
      } finally {
        // A failed poll rolls back the lock holder before draining the add and cleaning up the fixture.
        await pendingAdd;
      }
    }),
  );

  test("a 21st distinct emoji has a coded conflict; an existing emoji accepts another reactor", () =>
    fixture(async (f) => {
      for (const emoji of emojiSet.slice(0, 20)) await summary(await f.users[0]!.call(reactionPath(f.itemPath, emoji), "PUT"));
      const limited = await f.users[0]!.call(reactionPath(f.itemPath, emojiSet[20]!), "PUT");
      expect(limited.status).toBe(409);
      expect(await limited.json()).toMatchObject({ code: "REACTION_LIMIT_REACHED" });
      expect((await summary(await f.users[1]!.call(reactionPath(f.itemPath, emojiSet[0]!), "PUT"))).reactions[0]?.count).toBe(2);
    }));

  test("30 concurrent distinct adds never exceed 20 emoji", () =>
    fixture(async (f) => {
      const responses = await Promise.all(emojiSet.map((emoji) => f.users[0]!.call(reactionPath(f.itemPath, emoji), "PUT")));
      expect(responses.filter((r) => r.status === 200)).toHaveLength(20);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(10);
      expect(await reactions.listForItem(f.itemId, { kind: "user", id: f.users[0]!.id })).toHaveLength(20);
    }));

  test("an intent authorized for another Space finds no item", () =>
    fixture(async (f) => {
      // A transfer between the permission check and the write moves the item out of the authorized Space.
      const otherSpaceId = crypto.randomUUID();
      for (const operation of [reactions.add, reactions.remove])
        expect(
          await operation({ itemId: f.itemId, spaceId: otherSpaceId, emoji: "👍", actor: { kind: "user", id: f.users[0]!.id } }),
        ).toMatchObject({ ok: false, error: { status: 404 } });
      expect(await reactions.listForItem(f.itemId, { kind: "user", id: f.users[0]!.id })).toEqual([]);
    }));

  test("invalid emoji are 400, empty route segments are missing, service also validates", () =>
    fixture(async (f) => {
      for (const emoji of ["❤", "ab", "👍👍", " "]) {
        expect((await f.users[0]!.call(reactionPath(f.itemPath, emoji), "PUT")).status).toBe(400);
        expect((await f.users[0]!.call(reactionPath(f.itemPath, emoji), "DELETE")).status).toBe(400);
      }
      expect((await f.users[0]!.call(reactionPath(f.itemPath, ""), "PUT")).status).toBe(404);
      for (const operation of [reactions.add, reactions.remove])
        for (const emoji of ["", " ", "❤", "ab", "👍👍"]) {
          expect(
            await operation({ itemId: f.itemId, spaceId: f.spaceId, emoji, actor: { kind: "user", id: f.users[0]!.id } }),
          ).toMatchObject({
            ok: false,
            error: { status: 400 },
          });
        }
    }));

  test("only real changes publish live updates; no activity or timestamps change; item deletion cascades", () =>
    fixture(async (f) => {
      const path = reactionPath(f.itemPath, "👍");
      const before = (await spacesService.item.list({ spaceId: f.spaceId })).items[0];
      const events = () =>
        sql<
          { payload: { d?: { type: string } } }[]
        >`SELECT payload FROM events.outbox WHERE app_id = 'spaces' AND ordering_key = ${f.spaceId}`;
      expect(await events()).toHaveLength(0);
      await summary(await f.users[0]!.call(path, "DELETE"));
      expect(await events()).toHaveLength(0);
      await summary(await f.users[0]!.call(path, "PUT"));
      await summary(await f.users[0]!.call(path, "PUT"));
      expect((await events()).map((e) => e.payload.d?.type)).toEqual(["item.updated"]);
      await summary(await f.users[0]!.call(path, "DELETE"));
      await summary(await f.users[0]!.call(path, "DELETE"));
      expect((await events()).map((e) => e.payload.d?.type)).toEqual(["item.updated", "item.updated"]);
      const after = (await spacesService.item.list({ spaceId: f.spaceId })).items[0];
      expect(before?.lastActivityAt).toBe("2026-10-01T08:00:00.000Z");
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
      const [activity] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM spaces.activity_events WHERE item_id = ${f.itemId}`;
      expect(activity?.count).toBe(0);
      await summary(await f.users[0]!.call(path, "PUT"));
      await sql`DELETE FROM spaces.items WHERE id = ${f.itemId}`;
      const [remaining] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM spaces.item_reactions WHERE item_id = ${f.itemId}`;
      expect(remaining?.count).toBe(0);
      expect(
        await reactions.remove({ itemId: f.itemId, spaceId: f.spaceId, emoji: "👍", actor: { kind: "user", id: f.users[0]!.id } }),
      ).toMatchObject({
        ok: false,
        error: { status: 404 },
      });
    }));
});
