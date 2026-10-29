import { expect, test } from "bun:test";
import { sql } from "bun";
import { ItemFilterSchema } from "@/contracts";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import * as activity from "./activity";
import { listFiltered, searchAcross } from "./items";

const suite = databaseSuite();

suite("Spaces inactive task filtering", () => {
  test("includes only open tasks whose latest real activity is older than 30 days", async () => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name, color)
      VALUES (${newShortId()}, ${`Inactive ${crypto.randomUUID()}`}, '#6366f1')
      RETURNING id
    `;
    let accountId: string | undefined;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'To do', 1024)
        RETURNING id
      `;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES ('Inactivity reader', 'agent') RETURNING id`;
      accountId = account!.id;
      const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
        VALUES (${accountId}::uuid, 'read') RETURNING id`;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
      const across = () =>
        searchAcross({
          subject: { type: "service_account", serviceAccountId: account!.id },
          query: "",
          kinds: "task",
          activity: "inactive",
          spaceId: space!.id,
          limit: 20,
        });
      const [stale, fresh, event] = await sql<{ id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank, starts_at, ends_at, updated_at)
        VALUES
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Stale task', 1024, NULL, NULL, now() - interval '31 days'),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Fresh task', 2048, NULL, NULL, now()),
          (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Old event', 3072, now() - interval '31 days', now() - interval '30 days 23 hours', now() - interval '31 days')
        RETURNING id
      `;
      const filter = ItemFilterSchema.parse({ activity: "inactive", groupBy: "none" });
      const initial = await listFiltered({ spaceId: space!.id, filter });
      expect(initial.items.map((item) => item.title)).toEqual(["Stale task"]);
      expect((await across()).map((entry) => entry.item.title)).toEqual(["Stale task"]);

      await activity.record({
        spaceId: space!.id,
        itemId: stale!.id,
        actor: { kind: "system", id: null },
        action: "comment.created",
      });
      const refreshed = await listFiltered({ spaceId: space!.id, filter });
      expect(refreshed.items.map((item) => item.title)).toEqual(["Stale task"]);
      expect(refreshed.items[0]!.lastActivityAt).toBe(initial.items[0]!.lastActivityAt);
      expect((await across()).map((entry) => entry.item.title)).toEqual(["Stale task"]);
      await activity.record({
        spaceId: space!.id,
        itemId: stale!.id,
        actor: { kind: "system", id: null },
        action: "checklist.completed",
      });
      expect((await listFiltered({ spaceId: space!.id, filter })).items).toHaveLength(0);
      expect(await across()).toHaveLength(0);
      expect(fresh).toBeDefined();
      expect(event).toBeDefined();
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
    }
  });
});
