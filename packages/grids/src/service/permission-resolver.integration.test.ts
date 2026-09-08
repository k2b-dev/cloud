import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { loadBaseGrantsForSubject, loadCustomAppGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

describe("recursive Grids permission loading", () => {
  postgresTest("resolves nested membership from AccessSubject and observes revocation on the next query", async () => {
    await migrate();
    const [user] = await sql<Array<{ id: string; provider: "local" | "ipa" }>>`
      SELECT id::text AS id, provider FROM auth.users ORDER BY id LIMIT 1
    `;
    if (!user) throw new Error("Permission integration test needs one auth user");
    const baseId = Bun.randomUUIDv7();
    const childGroupId = Bun.randomUUIDv7();
    const parentGroupId = Bun.randomUUIDv7();
    const accessId = Bun.randomUUIDv7();
    const suffix = crypto.randomUUID().slice(0, 8);

    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, 'PR0001', 'Recursive permission test')`;
      await sql`
        INSERT INTO auth.groups (id, cn, provider, name)
        VALUES
          (${childGroupId}::uuid, ${`grids-child-${suffix}`}, ${user.provider}, ${`Grids child ${suffix}`}),
          (${parentGroupId}::uuid, ${`grids-parent-${suffix}`}, ${user.provider}, ${`Grids parent ${suffix}`})
      `;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user.id}::uuid, ${childGroupId}::uuid)`;
      await sql`
        INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
        VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)
      `;
      await sql`
        INSERT INTO auth.access (id, group_id, permission)
        VALUES (${accessId}::uuid, ${parentGroupId}::uuid, 'write'::auth.permission_level)
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;

      const nested = await loadBaseGrantsForSubject({ subject: { type: "user", userId: user.id }, baseId });
      expect(resolveEffectivePermission(nested, { baseId })).toBe("write");

      await sql`
        DELETE FROM auth.group_groups_v2
        WHERE parent_group_id = ${parentGroupId}::uuid AND child_group_id = ${childGroupId}::uuid
      `;
      const revoked = await loadBaseGrantsForSubject({ subject: { type: "user", userId: user.id }, baseId });
      expect(resolveEffectivePermission(revoked, { baseId })).toBe("none");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${childGroupId}::uuid, ${parentGroupId}::uuid)`;
    }
  });

  postgresTest("keeps public grants effective only for Grids Apps", async () => {
    await migrate();
    const baseId = Bun.randomUUIDv7();
    const customAppId = Bun.randomUUIDv7();
    const accessId = Bun.randomUUIDv7();

    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, 'PP0001', 'Public permission boundary')`;
      await sql`
        INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition)
        VALUES (${customAppId}::uuid, 'PA0001', ${baseId}::uuid, 'Public app', '{}'::jsonb)
      `;
      await sql`INSERT INTO auth.access (id, permission) VALUES (${accessId}::uuid, 'read'::auth.permission_level)`;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      await sql`INSERT INTO grids.custom_app_access (custom_app_id, access_id) VALUES (${customAppId}::uuid, ${accessId}::uuid)`;

      const baseGrants = await loadBaseGrantsForSubject({ subject: null, baseId });
      const appGrants = await loadCustomAppGrantsForSubject({ subject: null, customAppId });
      expect(resolveEffectivePermission(baseGrants, { baseId })).toBe("none");
      expect(resolveEffectivePermission(appGrants, { customAppId })).toBe("read");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });
});
