import { expect, setDefaultTimeout, test } from "bun:test";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { ItemFilterResponseSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import * as columnsService from "../service/columns";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(60_000);

type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

const caller =
  (token: string): Call =>
  async (path, init) =>
    spacesApi.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

const grant = async (spaceId: string, principal: { userId?: string; serviceAccountId?: string }, permission: "read" | "write") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, service_account_id, permission)
    VALUES (${principal.userId ?? null}::uuid, ${principal.serviceAccountId ?? null}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
};

suite("Spaces automatic Kanban columns", () => {
  test("people and agents who may change statuses enable and order them; readers and read-only tokens cannot", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [space] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Board ${suffix}`}) RETURNING id, short_id`;
    const userIds: string[] = [];
    const accountIds: string[] = [];
    try {
      const column = async (name: string, rank: number, isDone = false) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
          VALUES (${newShortId()}, ${space!.id}::uuid, ${name}, ${rank}, ${isDone}) RETURNING id, short_id`;
        return row!;
      };
      const open = await column("Open", 1024);
      const review = await column("Review", 2048);
      const done = await column("Done", 3072, true);
      const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const item = async (columnId: string, title: string, extra: { deadline?: string; completed?: boolean } = {}) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline, completed_at)
          VALUES (${newShortId()}, ${space!.id}::uuid, ${columnId}::uuid, ${title}, ${extra.deadline ?? null}::timestamptz,
            ${extra.completed ? new Date().toISOString() : null}::timestamptz)
          RETURNING id, short_id`;
        return row!;
      };
      const blocker = await item(review.id, "Approve the budget");
      const blocked = await item(open.id, "Order the stage");
      const overdue = await item(open.id, "Send the invitations", { deadline: yesterday });
      const both = await item(review.id, "Print the flyer", { deadline: yesterday });
      const plain = await item(open.id, "Ask the bakery");
      const finished = await item(done.id, "Book the square", { deadline: yesterday, completed: true });
      for (const waiting of [blocked, both]) {
        await sql`INSERT INTO spaces.item_dependencies (item_id, blocker_item_id) VALUES (${waiting.id}::uuid, ${blocker.id}::uuid)`;
      }

      const user = async (name: string, permission: "read" | "write") => {
        const id = crypto.randomUUID();
        await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${id}::uuid, ${`${name}-${suffix}`}, 'local', 'user', ${name})`;
        userIds.push(id);
        await grant(space!.id, { userId: id }, permission);
        const loaded = await accounts.users.get({ id });
        if (!loaded) throw new Error("Missing fixture user");
        const token = await serviceAccountCredentials.createUserApiToken({ user: loaded, name: `${name} key` });
        if (!token.ok) throw new Error(token.error.message);
        return caller(token.data.token);
      };
      const manager = await user("Manager", "write");
      const member = await user("Member", "read");

      const [agentRow] = await sql<
        { id: string }[]
      >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`Agent ${suffix}`}, 'agent') RETURNING id`;
      accountIds.push(agentRow!.id);
      await grant(space!.id, { serviceAccountId: agentRow!.id }, "write");
      const agentWith = async (scopes: string[]) => {
        const token = await serviceAccountCredentials.createApiToken({ serviceAccountId: agentRow!.id, name: scopes.join(" "), scopes });
        if (!token.ok) throw new Error(token.error.message);
        return caller(token.data.token);
      };
      const agent = await agentWith(["read", "write"]);
      const readOnlyAgent = await agentWith(["read"]);

      const base = `/${space!.short_id}`;
      const boardOrder = async (call: Call = manager) => {
        const detail = (await (await call(base)).json()) as {
          columns: { id: string; rank: string }[];
          virtualColumns: { kind: string; rank: string }[];
        };
        return [
          ...detail.columns.map((entry) => ({ id: entry.id, rank: BigInt(entry.rank), virtual: 0 })),
          ...detail.virtualColumns.map((entry) => ({ id: entry.kind, rank: BigInt(entry.rank), virtual: 1 })),
        ]
          .sort((a, b) => (a.rank === b.rank ? a.virtual - b.virtual : a.rank < b.rank ? -1 : 1))
          .map((entry) => entry.id);
      };

      // Off by default: an existing Space is unchanged.
      expect(await boardOrder(member)).toEqual([open.short_id, review.short_id, done.short_id]);

      // Readers and read-only tokens cannot enable, disable, or reorder.
      expect((await member(`${base}/virtual-columns/blocked`, { method: "PUT" })).status).toBe(403);
      expect((await readOnlyAgent(`${base}/virtual-columns/blocked`, { method: "PUT" })).status).toBe(403);
      expect((await member(`${base}/virtual-columns/blocked`, { method: "DELETE" })).status).toBe(403);
      expect((await manager(`${base}/virtual-columns/stalled`, { method: "PUT" })).status).toBe(400);

      // A new automatic column starts in front of the first done column; enabling it again keeps its place.
      const enabled = await manager(`${base}/virtual-columns/blocked`, { method: "PUT" });
      expect(enabled.status).toBe(200);
      expect(((await enabled.json()) as { kind: string }[]).map((entry) => entry.kind)).toEqual(["blocked"]);
      expect(await boardOrder()).toEqual([open.short_id, review.short_id, "blocked", done.short_id]);
      // An agent with a write grant and write scope behaves like a person with the same grant.
      expect((await agent(`${base}/virtual-columns/overdue`, { method: "PUT" })).status).toBe(200);
      expect((await manager(`${base}/virtual-columns/blocked`, { method: "PUT" })).status).toBe(200);
      expect(await boardOrder(member)).toEqual([open.short_id, review.short_id, "blocked", "overdue", done.short_id]);

      // Reorder for everyone; automatic columns are named by kind, and one left out keeps its place.
      const reorder = (call: Call, columnIds: string[]) => call(`${base}/columns/order`, { method: "PUT", body: { columnIds } });
      expect((await reorder(member, ["blocked", open.short_id, review.short_id, done.short_id])).status).toBe(403);
      expect((await reorder(readOnlyAgent, ["blocked", open.short_id, review.short_id, done.short_id])).status).toBe(403);
      expect((await reorder(manager, ["blocked", open.short_id, review.short_id, done.short_id])).status).toBe(200);
      expect(await boardOrder(member)).toEqual(["blocked", open.short_id, review.short_id, "overdue", done.short_id]);
      expect((await reorder(agent, [review.short_id, open.short_id, done.short_id])).status).toBe(200);
      expect(await boardOrder()).toEqual(["blocked", review.short_id, open.short_id, "overdue", done.short_id]);
      for (const invalid of [
        [open.short_id, review.short_id, done.short_id, open.short_id],
        [open.short_id, review.short_id],
        [open.short_id, review.short_id, done.short_id, "blocked", "blocked"],
      ]) {
        expect((await reorder(manager, invalid)).status).toBe(400);
      }

      // Board buckets: a task an automatic column gathers shows only there, Blocked before Overdue.
      const allResponse = await member(`${base}/items/filter`, { method: "POST", body: { status: "all" } });
      expect(allResponse.status).toBe(200);
      const allItems = ItemFilterResponseSchema.parse(await allResponse.json()).items;
      expect(allItems.find((entry) => entry.id === overdue.short_id)?.overdue).toBeTrue();
      expect(allItems.find((entry) => entry.id === finished.short_id)?.overdue).toBeFalse();
      expect(allItems.find((entry) => entry.id === plain.short_id)?.overdue).toBeFalse();
      const listed = async (filter: Record<string, unknown>) => {
        const response = await member(`${base}/items/filter`, { method: "POST", body: { sort: "title", ...filter } });
        expect(response.status).toBe(200);
        return ((await response.json()) as { items: { id: string }[] }).items.map((entry) => entry.id);
      };
      expect(await listed({ status: "active", blocked: true })).toEqual([blocked.short_id, both.short_id]);
      expect(await listed({ status: "active", overdue: true, blocked: false })).toEqual([overdue.short_id]);
      expect(await listed({ status: "active", columnIds: [open.short_id], blocked: false, overdue: false })).toEqual([plain.short_id]);
      expect(await listed({ status: "active", columnIds: [review.short_id], blocked: false, overdue: false })).toEqual([blocker.short_id]);
      expect(await listed({ status: "completed", columnIds: [done.short_id] })).toEqual([finished.short_id]);

      // The board snapshot builds the same buckets in board order, with counts that reflect the precedence.
      const snapshot = await member(`/workspace/view?href=${encodeURIComponent(`/app/spaces/${space!.short_id}?view=kanban`)}`);
      expect(snapshot.status).toBe(200);
      const { buckets } = (await snapshot.json()) as {
        buckets: { key: string; kind: string; label: string; total: number; items: { id: string }[] }[];
      };
      expect(buckets.map((bucket) => [bucket.key, bucket.kind, bucket.total])).toEqual([
        ["virtual:blocked", "blocked", 2],
        [`column:${review.short_id}`, "column", 1],
        [`column:${open.short_id}`, "column", 1],
        ["virtual:overdue", "overdue", 1],
        [`column:${done.short_id}`, "column", 1],
      ]);
      expect(buckets[0]!.label).toBe("Blocked");
      expect(buckets[3]!.items.map((entry) => entry.id)).toEqual([overdue.short_id]);

      // Items are never stored in an automatic column.
      const intoVirtual = await manager(`${base}/items/${plain.short_id}/move`, { method: "POST", body: { columnId: "blocked" } });
      expect(intoVirtual.status).toBe(400);

      // A new status goes to the very end of the board, after automatic columns too.
      const created = await manager(`${base}/columns`, { method: "POST", body: { name: "Archive" } });
      expect(created.status).toBe(200);
      const archive = ((await created.json()) as { id: string }).id;
      expect(await boardOrder()).toEqual(["blocked", review.short_id, open.short_id, "overdue", done.short_id, archive]);

      // Disabling returns the tasks to their statuses; the other automatic column stays.
      const disabled = await agent(`${base}/virtual-columns/blocked`, { method: "DELETE" });
      expect(disabled.status).toBe(200);
      expect(((await disabled.json()) as { kind: string }[]).map((entry) => entry.kind)).toEqual(["overdue"]);
      expect(await boardOrder()).toEqual([review.short_id, open.short_id, "overdue", done.short_id, archive]);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
      for (const id of userIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id IN (
          SELECT id FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid)`;
        await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
  });

  test("a reorder or switch that races a switch-off never brings the automatic column back", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${`Race ${crypto.randomUUID().slice(0, 8)}`}) RETURNING id`;
    const spaceId = space!.id;
    try {
      const statuses: string[] = [];
      for (const [index, name] of ["Open", "Doing", "Review", "Done"].entries()) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${name}, ${(index + 1) * 1024}, ${name === "Done"}) RETURNING id`;
        statuses.push(row!.id);
      }
      const enabledKinds = async () => (await columnsService.listVirtual({ spaceId })).map((entry) => entry.kind);
      const order = statuses.map((id) => ({ kind: "column" as const, id }));

      for (let round = 0; round < 15; round++) {
        await columnsService.disableVirtual({ spaceId, kind: "overdue" });
        await columnsService.enableVirtual({ spaceId, kind: "blocked" });
        // A reorder from a board that still shows Blocked: it fails or lands first, but never re-enables it.
        const [reordered] = await Promise.all([
          columnsService.reorder({ spaceId, order: [{ kind: "blocked" }, ...order] }),
          columnsService.disableVirtual({ spaceId, kind: "blocked" }),
        ]);
        if (!reordered.ok) expect(reordered.error).toBe("Automatic column blocked is not enabled");
        expect(await enabledKinds()).toEqual([]);

        // Switching one automatic column on while another goes off keeps both decisions.
        await columnsService.enableVirtual({ spaceId, kind: "blocked" });
        await Promise.all([
          columnsService.enableVirtual({ spaceId, kind: "overdue" }),
          columnsService.disableVirtual({ spaceId, kind: "blocked" }),
        ]);
        expect(await enabledKinds()).toEqual(["overdue"]);
      }

      // Concurrent new statuses each get their own place at the end of the board.
      await Promise.all(["One", "Two", "Three"].map((name) => columnsService.create({ spaceId, data: { name, isDone: false } })));
      const ranks = (await columnsService.list({ spaceId })).map((column) => column.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
    }
  });
});
