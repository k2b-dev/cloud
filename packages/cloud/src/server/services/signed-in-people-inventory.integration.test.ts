import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";

const note = readFileSync(new URL("../../../../../docs-site/docs/en/operations/app-access-upgrade.md", import.meta.url), "utf8");
const generator = note.split("BEGIN TRANSACTION READ ONLY;\n")[1]?.split("\\gexec")[0];

databaseSuite()("a tier meant for people admits machines: pre-switch inventory", () => {
  test("the documented query covers installed links and excludes direct, denied, public and nested-group alternatives", async () => {
    if (!generator) throw new Error("Missing documented inventory query");
    const rollback = new Error("rollback inventory fixtures");
    await expect(
      sql.begin(async (db) => {
        const prefix = `people-inventory-${crypto.randomUUID()}`;
        const accounts = await db<{ id: string; kind: string }[]>`INSERT INTO auth.service_accounts(name, kind, status)
        VALUES (${prefix}, 'agent', 'active'), (${prefix}, 'standalone', 'active'), (${prefix}, 'agent', 'disabled') RETURNING id, kind`;
        const [agent, standalone, disabled] = accounts;
        if (!agent || !standalone || !disabled) throw new Error("Missing machine fixtures");
        const groups = await db<{ id: string }[]>`INSERT INTO auth.groups(cn, name, provider)
        VALUES (${`${prefix}-parent`}, 'Parent', 'local'), (${`${prefix}-child`}, 'Child', 'local') RETURNING id`;
        const [parent, child] = groups;
        if (!parent || !child) throw new Error("Missing group fixtures");
        await db`INSERT INTO auth.service_account_groups(service_account_id, group_id) VALUES (${agent.id}::uuid, ${child.id}::uuid)`;
        await db`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${parent.id}::uuid, ${child.id}::uuid)`;
        const link = async (
          id: string,
          principal: { accountId?: string; groupId?: string; authenticated?: boolean },
          permission = "read",
        ) => {
          const [grant] = await db<{ id: string }[]>`INSERT INTO auth.access(service_account_id, group_id, authenticated_only, permission)
          VALUES (${principal.accountId ?? null}::uuid, ${principal.groupId ?? null}::uuid,
            ${principal.authenticated ?? false}, ${permission}::auth.permission_level) RETURNING id`;
          if (!grant) throw new Error("Missing grant fixture");
          await db`INSERT INTO auth.rail_shortcut_access(shortcut_id, access_id) VALUES (${id}, ${grant.id}::uuid)`;
        };
        for (const suffix of ["only", "direct", "denied", "group", "public", "deny-public"]) {
          const id = `${prefix}-${suffix}`;
          await db`INSERT INTO auth.rail_shortcuts(id, position, shortcut) VALUES (${id}, 0, '{}'::jsonb)`;
          await link(id, { authenticated: true });
          if (suffix === "direct" || suffix === "denied") {
            for (const account of [agent, standalone]) await link(id, { accountId: account.id }, suffix === "denied" ? "none" : "read");
          }
          if (suffix === "group") await link(id, { groupId: parent.id });
          if (suffix === "public" || suffix === "deny-public") await link(id, {}, suffix === "public" ? "read" : "none");
        }
        const [generated] = await db.unsafe<{ inventory_query: string }[]>(generator);
        if (!generated) throw new Error("Inventory did not generate a query");
        const rows = await db.unsafe<{ service_account_id: string; link_table: string; resource_id: string[] }[]>(
          generated.inventory_query,
        );
        const matching = rows.filter((row) => row.link_table === "auth.rail_shortcut_access" && row.resource_id[0]?.startsWith(prefix));
        expect(matching.map((row) => `${row.service_account_id}:${row.resource_id[0]}`).sort()).toEqual(
          [
            `${agent.id}:${prefix}-only`,
            `${agent.id}:${prefix}-deny-public`,
            `${standalone.id}:${prefix}-only`,
            `${standalone.id}:${prefix}-deny-public`,
            `${standalone.id}:${prefix}-group`,
          ].sort(),
        );
        const references = await db<{ link_table: string }[]>`SELECT DISTINCT conrelid::regclass::text AS link_table
        FROM pg_constraint WHERE contype = 'f' AND confrelid = 'auth.access'::regclass`;
        for (const { link_table } of references) {
          if (link_table === "assistant.artifact_machine_rights" || link_table.startsWith("code.")) continue;
          expect(generated.inventory_query).toContain(`'${link_table}'::text AS link_table`);
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
