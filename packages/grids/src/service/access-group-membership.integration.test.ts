import { beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { AccessMutationBusyError } from "@k2b/cloud/server";
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
      postgresTest(`${kind}: ${resourceType} recipient deletion refuses ${operation} before membership locks`, async () => {
        const baseId = testUuid();
        const appId = testUuid();
        const groupId = testUuid();
        const accountId = testUuid();
        const accessId = testUuid();
        let pending: ReturnType<typeof grantAccess> | ReturnType<typeof revokeAccess> | undefined;
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
            pending = mutation;
            // Contention aborts before taking directory or target locks, so the
            // deleting transaction can finish its cascades without a deadlock.
            await expect(pending).rejects.toBeInstanceOf(AccessMutationBusyError);
            await tx`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
          });
          if (!pending) throw new Error("Grant mutation did not start");
          const result = await (operation === "grant"
            ? grantAccess({
                resourceType,
                resourceId: resourceType === "base" ? baseId : appId,
                principal: { type: "service_account", serviceAccountId: accountId },
                permission: "read",
              })
            : operation === "update"
              ? updateAccessLevel(accessId, "none")
              : revokeAccess(accessId));
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

  postgresTest(`${kind}: inherited administration refuses a pending membership removal`, async () => {
    const baseId = testUuid();
    const appId = testUuid();
    const groupId = testUuid();
    const accountId = testUuid();
    const grantId = testUuid();
    const accessIds = [grantId];
    let pending: ReturnType<typeof grantAccess> | undefined;
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
        pending = grantAccess({
          resourceType: "customApp",
          resourceId: appId,
          principal: { type: "public" },
          permission: "read",
          authorization: { subject: { type: "service_account", serviceAccountId: accountId }, permissionCap: "admin" },
        });
        await expect(pending).rejects.toBeInstanceOf(AccessMutationBusyError);
      });
      if (!pending) throw new Error("Grant mutation did not start");
      const result = await grantAccess({
        resourceType: "customApp",
        resourceId: appId,
        principal: { type: "public" },
        permission: "read",
        authorization: { subject: { type: "service_account", serviceAccountId: accountId }, permissionCap: "admin" },
      });
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
