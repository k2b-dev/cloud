import { expect, test } from "bun:test";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import * as templates from "./item-templates";
import * as items from "./items";

const suite = databaseSuite();

suite("Space assignee presentation", () => {
  test("exact selected IDs keep both machine kinds beyond the first page, through items and templates, without widening visibility", async () => {
    const suffix = crypto.randomUUID();
    const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
      VALUES (${newShortId()}, 'Assignee presentation') RETURNING id`;
    const users = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      SELECT ${suffix} || '-' || n, 'local', 'user', 'Aardvark ' || n FROM generate_series(1, 101) n RETURNING id`;
    const accounts = await sql<{ id: string; kind: "standalone" | "agent"; name: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`Zebra service ${suffix}`}, 'standalone'), (${`Zebra agent ${suffix}`}, 'agent'), (${`Outside ${suffix}`}, 'agent') RETURNING id, kind, name`;
    const eligible = accounts.slice(0, 2);
    const grants = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      SELECT id, 'write' FROM unnest(${toPgUuidArray(users.map((user) => user.id))}::uuid[]) id RETURNING id`;
    grants.push(
      ...(await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
      SELECT id, 'write' FROM unnest(${toPgUuidArray(eligible.map((account) => account.id))}::uuid[]) id RETURNING id`),
    );
    await sql`INSERT INTO spaces.space_access (space_id, access_id)
      SELECT ${space!.id}::uuid, id FROM unnest(${toPgUuidArray(grants.map((grant) => grant.id))}::uuid[]) id`;
    try {
      const firstPage = await items.listAssignableUsers({ spaceId: space!.id, limit: 100 });
      expect(firstPage).toHaveLength(100);
      expect(firstPage.some((entry) => entry.kind === "service_account")).toBe(false);
      const exact = await items.listAssignableUsers({ spaceId: space!.id, ids: accounts.map((account) => account.id), limit: 100 });
      expect(exact).toHaveLength(2);
      for (const account of eligible)
        expect(exact).toContainEqual(
          expect.objectContaining({
            id: account.id,
            kind: "service_account",
            serviceAccountKind: account.kind,
            displayName: account.name,
          }),
        );
      expect(exact.some((entry) => entry.id === accounts[2]!.id)).toBe(false);
      expect(await items.listAssignableUsers({ spaceId: space!.id, ids: [], limit: 100 })).toEqual([]);
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Open', 1024) RETURNING id`;
      const [item] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Assigned work') RETURNING id`;
      const [template] = await sql<{ id: string }[]>`INSERT INTO spaces.item_templates (short_id, space_id, kind, name)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'task', 'Assigned default') RETURNING id`;
      for (const account of eligible) {
        await sql`INSERT INTO spaces.item_assignees (item_id, service_account_id) VALUES (${item!.id}::uuid, ${account.id}::uuid)`;
        await sql`INSERT INTO spaces.item_template_assignees (template_id, service_account_id) VALUES (${template!.id}::uuid, ${account.id}::uuid)`;
      }
      const detail = await items.get({ id: item!.id });
      const list = await items.list({ spaceId: space!.id });
      const defaults = await templates.get({ id: template!.id });
      for (const assignees of [detail?.assignees, list[0]?.assignees, defaults?.assignees]) {
        expect(assignees).toHaveLength(2);
        for (const account of eligible)
          expect(assignees).toContainEqual(
            expect.objectContaining({
              id: account.id,
              kind: "service_account",
              serviceAccountKind: account.kind,
              displayName: account.name,
            }),
          );
      }
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(grants.map((grant) => grant.id))}::uuid[])`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(accounts.map((account) => account.id))}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(users.map((user) => user.id))}::uuid[])`;
    }
  });
});
