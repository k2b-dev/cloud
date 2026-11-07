import { expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "../packages/cloud/src/runtime/clients";
import { databaseSuite } from "../scripts/fixtures/test-infra";
import { testShortId } from "../scripts/fixtures/test-short-id";

setDefaultTimeout(30_000);

databaseSuite()("guest app-access upgrade inventory", () => {
  test("the documented SELECT counts direct and nested grants across every access link table without duplicates", async () => {
    const doc = await Bun.file(new URL("../docs-site/docs/en/operations/app-access-upgrade.md", import.meta.url)).text();
    const query = doc.split("## Check guest access before upgrading")[1]?.match(/```sql\n([\s\S]*?)\n```/)?.[1];
    if (!query) throw new Error("The upgrade note must contain its read-only inventory query");
    expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
    const suffix = crypto.randomUUID();
    const direct = crypto.randomUUID();
    const nested = crypto.randomUUID();
    const empty = crypto.randomUUID();
    const full = crypto.randomUUID();
    const parent = crypto.randomUUID();
    const child = crypto.randomUUID();
    const read = crypto.randomUUID();
    const inherited = crypto.randomUUID();
    const none = crypto.randomUUID();
    const fullGrant = crypto.randomUUID();
    const object = crypto.randomUUID();
    const rollback = new Error("Roll back the inventory fixture");
    await expect(
      sql.begin(async (tx) => {
        for (const id of [direct, nested, empty, full])
          await tx`INSERT INTO auth.users(id,uid,provider,profile)
            VALUES(${id}::uuid,${`${suffix}-${id}`},'local',${id === full ? "user" : "guest"})`;
        for (const id of [parent, child]) await tx`INSERT INTO auth.groups(id,cn,name,provider) VALUES(${id}::uuid,${id},${id},'local')`;
        for (const id of [direct, nested]) await tx`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES(${id}::uuid,${child}::uuid)`;
        await tx`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${parent}::uuid,${child}::uuid)`;
        await tx`INSERT INTO auth.access(id,user_id,permission) VALUES(${read}::uuid,${direct}::uuid,'read'),
          (${none}::uuid,${empty}::uuid,'none'),(${fullGrant}::uuid,${full}::uuid,'admin')`;
        await tx`INSERT INTO auth.access(id,group_id,permission) VALUES(${inherited}::uuid,${parent}::uuid,'write')`;
        await tx`INSERT INTO spaces.spaces(id,short_id,name) VALUES(${object}::uuid,${testShortId()},'Inventory space')`;
        await tx`INSERT INTO grids.bases(id,short_id,name) VALUES(${object}::uuid,${testShortId()},'Inventory base')`;
        // The same UUID across resource types must still count as two Grids objects.
        await tx`INSERT INTO grids.custom_apps(id,short_id,base_id,name,draft_definition)
          VALUES(${object}::uuid,${testShortId()},${object}::uuid,'Inventory app','{}')`;
        await tx`INSERT INTO contacts.books(id,short_id,name) VALUES(${object}::uuid,${testShortId()},'Inventory book')`;
        await tx`INSERT INTO mail.mailboxes(id,short_id,name) VALUES(${object}::uuid,${testShortId()},'Inventory mailbox')`;
        await tx`INSERT INTO pulse.bases(id,short_id,name) VALUES(${object}::uuid,${testShortId()},'Inventory base')`;
        await tx`INSERT INTO venue.venues(id,short_id,name,slug) VALUES(${object}::uuid,${testShortId()},'Inventory venue',${suffix})`;
        for (const access of [read, inherited, none, fullGrant]) {
          await tx`INSERT INTO spaces.space_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO grids.base_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO grids.custom_app_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO contacts.book_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO mail.mailbox_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO mail.mailbox_assigned_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO pulse.base_access VALUES(${object}::uuid,${access}::uuid)`;
          await tx`INSERT INTO venue.venue_access VALUES(${object}::uuid,${access}::uuid)`;
        }
        const report = async () =>
          (await tx.unsafe<{ guest_id: string; app: string; object_count: bigint }[]>(query))
            .filter((row) => [direct, nested, empty, full].includes(row.guest_id))
            .map((row) => ({ guest_id: row.guest_id, app: row.app, object_count: Number(row.object_count) }));
        const expected = (id: string) =>
          ["contacts", "grids", "mail", "pulse", "spaces", "venue"].map((app) => ({
            guest_id: id,
            app,
            object_count: app === "grids" ? 2 : 1,
          }));
        const rows = await report();
        expect(rows).toHaveLength(12);
        expect(rows).toEqual(expect.arrayContaining([...expected(direct), ...expected(nested)]));
        // Leave only assigned-conversation rights for Mail and only custom-app rights for Grids.
        await tx`DELETE FROM mail.mailbox_access WHERE mailbox_id=${object}::uuid`;
        await tx`DELETE FROM grids.base_access WHERE base_id=${object}::uuid`;
        const narrower = await report();
        expect(narrower).toHaveLength(12);
        expect(narrower).toEqual(
          expect.arrayContaining([...expected(direct), ...expected(nested)].map((row) => ({ ...row, object_count: 1 }))),
        );
        await tx`DELETE FROM auth.user_groups_v2 WHERE user_id=${nested}::uuid`;
        expect(await report()).toHaveLength(6);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await sql`SELECT id FROM auth.users WHERE id=${direct}::uuid`).toHaveLength(0);
  });
});
