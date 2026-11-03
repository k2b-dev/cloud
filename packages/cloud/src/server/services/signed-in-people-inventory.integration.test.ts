import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";

const note = readFileSync(new URL("../../../../../docs-site/docs/en/operations/app-access-upgrade.md", import.meta.url), "utf8");
const generator = note.split("BEGIN TRANSACTION READ ONLY;\n")[1]?.split("\\gexec")[0];

databaseSuite()("a tier meant for people admits machines: pre-switch inventory", () => {
  test("the documented query reports lost permission unless an equal or stronger grant remains", async () => {
    if (!generator) throw new Error("Missing documented inventory query");
    const rollback = new Error("rollback inventory fixtures");
    await expect(
      sql.begin(async (db) => {
        const prefix = `people-inventory-${crypto.randomUUID()}`;
        const accounts = await db<{ id: string; kind: string }[]>`INSERT INTO auth.service_accounts(name, kind, status)
        VALUES (${prefix}, 'agent', 'active'), (${prefix}, 'standalone', 'active'), (${prefix}, 'agent', 'disabled') RETURNING id, kind`;
        const [agent, standalone, disabled] = accounts;
        if (!agent || !standalone || !disabled) throw new Error("Missing machine fixtures");
        const [bound] = await db<{ id: string }[]>`INSERT INTO auth.service_accounts
        (name, kind, status, app_id, resource_type, resource_id)
        VALUES (${prefix}, 'resource_bound', 'active', 'core', 'fixture', ${prefix}) RETURNING id`;
        if (!bound) throw new Error("Missing resource-bound fixture");
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
        for (const suffix of [
          "only",
          "direct",
          "denied",
          "group",
          "public",
          "deny-public",
          "weaker-direct",
          "weaker-group",
          "denied-group",
          "weaker-public",
          "stronger-public",
          "admin",
        ]) {
          const id = `${prefix}-${suffix}`;
          await db`INSERT INTO auth.rail_shortcuts(id, position, shortcut) VALUES (${id}, 0, '{}'::jsonb)`;
          await link(id, { authenticated: true }, suffix === "admin" ? "admin" : suffix.startsWith("weaker-") ? "write" : "read");
          if (["direct", "denied", "weaker-direct", "admin"].includes(suffix)) {
            for (const account of [agent, standalone, bound])
              await link(id, { accountId: account.id }, suffix === "denied" ? "none" : suffix === "admin" ? "write" : "read");
          }
          if (["group", "weaker-group", "denied-group"].includes(suffix))
            await link(id, { groupId: parent.id }, suffix === "denied-group" ? "none" : "read");
          if (["public", "deny-public", "weaker-public", "stronger-public"].includes(suffix))
            await link(id, {}, suffix === "deny-public" ? "none" : suffix === "stronger-public" ? "write" : "read");
        }
        const [generated] = await db.unsafe<{ inventory_query: string }[]>(generator);
        if (!generated) throw new Error("Inventory did not generate a query");
        const rows = await db.unsafe<{ service_account_id: string; link_table: string; resource_id: string[]; lost_permission: string }[]>(
          generated.inventory_query,
        );
        const matching = rows.filter((row) => row.link_table === "auth.rail_shortcut_access" && row.resource_id[0]?.startsWith(prefix));
        expect(matching.map((row) => `${row.service_account_id}:${row.resource_id[0]}:${row.lost_permission}`).sort()).toEqual(
          [
            ...[agent, standalone, bound].flatMap((account) => [
              `${account.id}:${prefix}-only:read`,
              `${account.id}:${prefix}-denied:read`,
              `${account.id}:${prefix}-deny-public:read`,
              `${account.id}:${prefix}-weaker-direct:write`,
              `${account.id}:${prefix}-weaker-group:write`,
              `${account.id}:${prefix}-denied-group:read`,
              `${account.id}:${prefix}-weaker-public:write`,
              `${account.id}:${prefix}-admin:admin`,
            ]),
            `${standalone.id}:${prefix}-group:read`,
            `${bound.id}:${prefix}-group:read`,
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
