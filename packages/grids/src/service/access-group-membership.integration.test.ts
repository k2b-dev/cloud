import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, listBaseAccess, listCustomAppAccess, revokeAccess, updateAccessLevel } from "./access";

const postgresTest = testFor("database");
beforeAll(async () => {
  if (testInfra.database) await migrate();
});

for (const kind of ["standalone", "agent"] as const) {
  for (const resourceType of ["base", "customApp"] as const) {
    for (const operation of ["grant", "update", "revoke"] as const) {
      postgresTest(`${kind}: ${resourceType} recipient deletion precedes ${operation} membership locks`, async () => {
        const baseId = testUuid();
        const appId = testUuid();
        const groupId = testUuid();
        const accountId = testUuid();
        const accessId = testUuid();
        let pending: ReturnType<typeof grantAccess> | ReturnType<typeof revokeAccess> | undefined;
        let settled = false;
        try {
          await sql`INSERT INTO auth.groups (id, cn, name, provider)
          VALUES (${groupId}::uuid, ${groupId}, 'Recipient group', 'local')`;
          await sql`INSERT INTO auth.service_accounts (id, name, kind)
          VALUES (${accountId}::uuid, ${`Grant recipient ${accountId}`}, ${kind})`;
          await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id)
          VALUES (${accountId}::uuid, ${groupId}::uuid)`;
          await sql`INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${testShortId()}, 'Recipient deletion')`;
          await sql`INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, draft_capabilities)
          VALUES (${appId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Recipient app', '{}'::jsonb, NULL)`;

          if (operation !== "grant") {
            await sql`INSERT INTO auth.access (id, service_account_id, permission)
            VALUES (${accessId}::uuid, ${accountId}::uuid, 'read')`;
            if (resourceType === "base") {
              await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
            } else {
              await sql`INSERT INTO grids.custom_app_access (custom_app_id, access_id) VALUES (${appId}::uuid, ${accessId}::uuid)`;
            }
          }

          await sql.begin(async (tx) => {
            // Stop deletion after its row lock, before its membership cascade.
            await tx`SELECT id FROM auth.service_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
            // On upgrades the older access FK can cascade before the membership FK.
            // Reproduce that order without depending on database trigger names.
            if (operation !== "grant") await tx`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
            await tx`SET LOCAL lock_timeout = '2s'`;
            const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
            if (!holder) throw new Error("Missing transaction identity");
            const mutation =
              operation === "grant"
                ? grantAccess({
                    resourceType,
                    resourceId: resourceType === "base" ? baseId : appId,
                    principal: { type: "service_account", serviceAccountId: accountId },
                    permission: "read",
                  })
                : operation === "update"
                  ? updateAccessLevel(accessId, "none")
                  : revokeAccess(accessId);
            pending = mutation.finally(() => {
              settled = true;
            });
            pending.catch(() => {});
            const deadline = performance.now() + 2_000;
            for (;;) {
              const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND ${holder.pid}::int = ANY(pg_blocking_pids(pid))
            ) AS blocked`;
              if (state?.blocked) break;
              if (settled) throw new Error("Grant mutation did not wait for recipient deletion");
              if (performance.now() >= deadline) throw new Error("Grant mutation did not reach the recipient lock");
            }
            // The actual delete must be able to acquire its membership cascade
            // locks while the grant waits. The old order deadlocks at this point.
            await tx`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
          });
          if (!pending) throw new Error("Grant mutation did not start");
          const result = await pending;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.status).toBe(404);
          expect(await listBaseAccess(baseId)).toEqual([]);
          expect(await listCustomAppAccess(appId)).toEqual([]);
          const memberships = await sql<{ service_account_id: string }[]>`
            SELECT service_account_id FROM auth.service_account_groups WHERE service_account_id = ${accountId}::uuid
          `;
          expect(memberships).toHaveLength(0);
        } finally {
          // A failed deletion rolls back before draining the grant and fixtures.
          await pending?.catch(() => null);
          await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
          await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
          await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
          await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
        }
      });
    }
  }

  postgresTest(`${kind}: inherited administration waits for a pending membership removal`, async () => {
    const baseId = testUuid();
    const appId = testUuid();
    const groupId = testUuid();
    const accountId = testUuid();
    const grantId = testUuid();
    const accessIds = [grantId];
    let pending: ReturnType<typeof grantAccess> | undefined;
    let settled = false;
    try {
      await sql`INSERT INTO auth.groups (id, cn, name, provider)
        VALUES (${groupId}::uuid, ${groupId}, 'Account administrators', 'local')`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind)
        VALUES (${accountId}::uuid, ${`Group administrator ${accountId}`}, ${kind})`;
      await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id)
        VALUES (${accountId}::uuid, ${groupId}::uuid)`;
      await sql`INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${testShortId()}, 'Group administration')`;
      await sql`INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, draft_capabilities)
        VALUES (${appId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Group app', '{}'::jsonb, NULL)`;
      await sql`INSERT INTO auth.access (id, group_id, permission)
        VALUES (${grantId}::uuid, ${groupId}::uuid, 'admin')`;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${grantId}::uuid)`;

      await sql.begin(async (tx) => {
        await tx`DELETE FROM auth.service_account_groups
          WHERE service_account_id = ${accountId}::uuid AND group_id = ${groupId}::uuid`;
        const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        if (!holder) throw new Error("Missing transaction identity");
        pending = grantAccess({
          resourceType: "customApp",
          resourceId: appId,
          principal: { type: "public" },
          permission: "read",
          authorization: { subject: { type: "service_account", serviceAccountId: accountId }, permissionCap: "admin" },
        }).finally(() => {
          settled = true;
        });
        pending.catch(() => {});
        const deadline = performance.now() + 2_000;
        for (;;) {
          const [state] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND ${holder.pid}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
          if (state?.blocked) break;
          if (settled) throw new Error("Grant mutation did not wait for membership removal");
          if (performance.now() >= deadline) throw new Error("Grant mutation did not reach the membership lock");
        }
      });
      if (!pending) throw new Error("Grant mutation did not start");
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(403);
      expect(await listCustomAppAccess(appId)).toEqual([]);
    } finally {
      const result = await pending?.catch(() => null);
      if (result?.ok) accessIds.push(result.data.accessId);
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });
}
