import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listForBase as listBaseCatalog } from "./base-catalog";
import { listVisible as listVisibleBases } from "./bases";
import { loadBaseGrantsForSubject, loadCustomAppGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import { listForTable as listViewsForTable } from "./views";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("authorization projections", () => {
  postgresTest("resolve recursive groups authoritatively and ignore caller-supplied group ids", async () => {
    const nestedUserId = testUuid();
    const outsideUserId = testUuid();
    const parentGroupId = testUuid();
    const childGroupId = testUuid();
    const baseId = testUuid();
    const tableId = testUuid();
    const viewId = testUuid();
    const customAppId = testUuid();
    const accessIds = [testUuid(), testUuid()];

    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
          (${nestedUserId}::uuid, ${`nested-${nestedUserId}`}, 'local', 'user', 'Nested user', 'Nested', 'User'),
          (${outsideUserId}::uuid, ${`outside-${outsideUserId}`}, 'local', 'user', 'Outside user', 'Outside', 'User')
      `;
      await sql`
        INSERT INTO auth.groups (id, cn, provider, name) VALUES
          (${parentGroupId}::uuid, ${`parent-${parentGroupId}`}, 'local', 'Parent group'),
          (${childGroupId}::uuid, ${`child-${childGroupId}`}, 'local', 'Child group')
      `;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedUserId}::uuid, ${childGroupId}::uuid)`;
      await sql`
        INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
        VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Nested access')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Nested table')
      `;
      await sql`
        INSERT INTO grids.views (id, short_id, table_id, name, source, owner_user_id)
        VALUES (${viewId}::uuid, ${testShortId("V")}, ${tableId}::uuid, 'Nested view', 'from table "Nested table"', ${outsideUserId}::uuid)
      `;
      await sql`
        INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, draft_capabilities)
        VALUES (${customAppId}::uuid, ${testShortId("C")}, ${baseId}::uuid, 'Nested app', '{}'::jsonb, '{"views":[]}'::jsonb)
      `;
      await sql`
        INSERT INTO auth.access (id, group_id, permission) VALUES
          (${accessIds[0]}::uuid, ${parentGroupId}::uuid, 'read'),
          (${accessIds[1]}::uuid, ${parentGroupId}::uuid, 'read')
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessIds[0]}::uuid)`;
      await sql`INSERT INTO grids.custom_app_access (custom_app_id, access_id) VALUES (${customAppId}::uuid, ${accessIds[1]}::uuid)`;

      const nestedBases = await listVisibleBases({ userId: nestedUserId, userGroups: [] });
      expect(nestedBases.items.map((base) => base.id)).toContain(baseId);
      expect((await listBaseCatalog({ baseId, userId: nestedUserId, userGroups: [] })).tables.map((table) => table.id)).toContain(tableId);
      expect((await listViewsForTable({ tableId, userId: nestedUserId, userGroups: [] })).map((view) => view.id)).toContain(viewId);
      const subject = { type: "user" as const, userId: nestedUserId };
      expect(resolveEffectivePermission(await loadBaseGrantsForSubject({ baseId, subject }), { baseId })).toBe("read");
      expect(resolveEffectivePermission(await loadCustomAppGrantsForSubject({ customAppId, subject }), { customAppId })).toBe("read");

      expect((await listVisibleBases({ userId: outsideUserId, userGroups: [parentGroupId] })).items.map((base) => base.id)).not.toContain(
        baseId,
      );
      expect((await listBaseCatalog({ baseId, userId: outsideUserId, userGroups: [parentGroupId] })).tables).toEqual([]);

      await sql`
        DELETE FROM auth.group_groups_v2
        WHERE parent_group_id = ${parentGroupId}::uuid AND child_group_id = ${childGroupId}::uuid
      `;
      expect((await listVisibleBases({ userId: nestedUserId, userGroups: [parentGroupId] })).items.map((base) => base.id)).not.toContain(
        baseId,
      );
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ANY(${sql.array(accessIds, "UUID")})`;
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${nestedUserId}::uuid`;
      await sql`
        DELETE FROM auth.group_groups_v2
        WHERE parent_group_id = ${parentGroupId}::uuid OR child_group_id = ${childGroupId}::uuid
      `;
      await sql`DELETE FROM auth.groups WHERE id IN (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${nestedUserId}::uuid, ${outsideUserId}::uuid)`;
    }
  });
});
