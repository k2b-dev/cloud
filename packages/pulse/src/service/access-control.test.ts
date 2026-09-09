import { describe, expect, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { listBaseIdsVisibleTo, type ResourceScope, requireBaseAccess } from "./access-control";
import { grantBaseAccess, listBaseAccess } from "./base-management";
import {
  createSourceApiKey,
  listSourceApiKeys,
  removeSource,
  removeSourceApiKey,
  resolveIngestSourceForServiceAccount,
} from "./source-management";

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ bases: string | null; access: string | null }[]>`
      SELECT to_regclass('pulse.bases')::text AS bases, to_regclass('auth.access')::text AS access
    `;
    return Boolean(row?.bases && row.access);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

const insertUser = async (suffix: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`pulse-access-${suffix}`}, 'local', 'user', 'Pulse access test', ${`pulse-access-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (suffix: string, label: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${`pulse-access-${label}-${suffix}`}, 'local', ${`Pulse ${label}`}, 'Pulse access test')
    RETURNING id
  `;
  return row!.id;
};

const testUser = (id: string, suffix: string): User => ({
  id,
  uid: `pulse-access-${suffix}`,
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Pulse",
  sn: "Access",
  displayName: "Pulse access test",
  mail: `pulse-access-${suffix}@example.test`,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

const insertServiceAccount = async (params: { suffix: string; resourceType: string; resourceId: string }): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (
      ${`Pulse ${params.resourceType} ${params.suffix}`},
      'resource_bound',
      'pulse',
      ${params.resourceType},
      ${params.resourceId}
    )
    RETURNING id
  `;
  return row!.id;
};

const resourceScope = (params: {
  serviceAccountId: string;
  resourceType: string;
  resourceId: string;
  scopes: string[];
}): ResourceScope => ({
  subject: { type: "service_account", serviceAccountId: params.serviceAccountId },
  serviceAccount: {
    appId: "pulse",
    resourceType: params.resourceType,
    resourceId: params.resourceId,
  },
  scopes: params.scopes,
});

suite("Pulse base access", () => {
  test("uses effective groups and rejects unsupported resource service-account scopes", async () => {
    const suffix = crypto.randomUUID();
    const baseId = crypto.randomUUID();
    const baseShortId = newShortId();
    const noneBaseId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const sourceShortId = newShortId();
    const userId = await insertUser(suffix);
    const user = testUser(userId, suffix);
    const parentGroupId = await insertGroup(suffix, "parent");
    const childGroupId = await insertGroup(suffix, "child");
    const baseServiceAccountId = await insertServiceAccount({ suffix, resourceType: "pulse_base", resourceId: baseShortId });
    const sourceServiceAccountId = crypto.randomUUID();
    const accessIds: string[] = [];

    try {
      await sql`
        INSERT INTO pulse.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${baseShortId}, 'Pulse access test'), (${noneBaseId}::uuid, ${newShortId()}, 'Pulse none access test')
      `;
      await sql`
        INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
        VALUES (${sourceId}::uuid, ${sourceShortId}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Pulse access source')
      `;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${childGroupId}::uuid)`;
      await sql`
        INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
        VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)
      `;

      const [groupAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (group_id, permission) VALUES (${parentGroupId}::uuid, 'write') RETURNING id
      `;
      const [authenticatedAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (authenticated_only, permission) VALUES (TRUE, 'read') RETURNING id
      `;
      const [publicAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (permission) VALUES ('read') RETURNING id
      `;
      accessIds.push(groupAccess!.id, authenticatedAccess!.id, publicAccess!.id);
      await sql`
        INSERT INTO pulse.base_access (base_id, access_id)
        VALUES
          (${baseId}::uuid, ${groupAccess!.id}::uuid),
          (${baseId}::uuid, ${authenticatedAccess!.id}::uuid),
          (${baseId}::uuid, ${publicAccess!.id}::uuid)
      `;

      const [noneAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'none') RETURNING id
      `;
      accessIds.push(noneAccess!.id);
      await sql`
        INSERT INTO pulse.base_access (base_id, access_id)
        VALUES (${noneBaseId}::uuid, ${noneAccess!.id}::uuid)
      `;

      expect((await requireBaseAccess(baseId, { id: userId }, "write")).ok).toBe(true);
      expect(await listBaseIdsVisibleTo({ id: userId })).not.toContain(noneBaseId);

      const readableBaseAccount = resourceScope({
        serviceAccountId: baseServiceAccountId,
        resourceType: "pulse_base",
        resourceId: baseShortId,
        scopes: ["read"],
      });
      expect((await requireBaseAccess(baseId, readableBaseAccount, "read")).ok).toBe(true);
      expect((await requireBaseAccess(baseId, readableBaseAccount, "write")).ok).toBe(false);
      expect(await listBaseIdsVisibleTo(readableBaseAccount)).toEqual([baseId]);
      expect(
        (
          await requireBaseAccess(
            baseId,
            { ...readableBaseAccount, serviceAccount: { ...readableBaseAccount.serviceAccount, resourceId: baseId } },
            "read",
          )
        ).ok,
      ).toBe(false);

      const sourceAccount = resourceScope({
        serviceAccountId: sourceServiceAccountId,
        resourceType: "pulse_source",
        resourceId: sourceShortId,
        scopes: ["admin"],
      });
      expect((await requireBaseAccess(baseId, sourceAccount, "read")).ok).toBe(false);

      const serviceAccount = {
        id: sourceServiceAccountId,
        name: "Pulse source ingest",
        kind: "resource_bound" as const,
        status: "active" as const,
        delegatedUserId: null,
        appId: "pulse",
        resourceType: "pulse_source",
        resourceId: sourceShortId,
        createdBy: userId,
        createdAt: new Date().toISOString(),
      };
      expect(await resolveIngestSourceForServiceAccount(serviceAccount)).toEqual({
        ok: true,
        data: { id: sourceId, baseId },
      });
      expect((await resolveIngestSourceForServiceAccount({ ...serviceAccount, resourceId: sourceId })).ok).toBe(false);

      const [adminAccess] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'admin') RETURNING id
      `;
      accessIds.push(adminAccess!.id);
      await sql`
        INSERT INTO pulse.base_access (base_id, access_id)
        VALUES (${baseId}::uuid, ${adminAccess!.id}::uuid)
      `;

      const granted = await grantBaseAccess({
        baseId,
        user,
        principal: { type: "service_account", serviceAccountId: baseServiceAccountId },
        permission: "read",
      });
      expect(granted.ok).toBe(true);
      if (granted.ok) accessIds.push(granted.data.id);
      expect((await requireBaseAccess(baseId, readableBaseAccount, "read")).ok).toBe(true);
      expect(await listBaseIdsVisibleTo(readableBaseAccount)).toEqual([baseId]);

      const entries = await listBaseAccess(baseId, { id: userId });
      expect(entries.ok).toBe(true);
      if (entries.ok) {
        expect(
          entries.data.some(
            (entry) => entry.principal.type === "service_account" && entry.principal.serviceAccountId === baseServiceAccountId,
          ),
        ).toBe(true);
      }

      const createdKey = await createSourceApiKey({
        baseId,
        sourceId,
        user,
        name: "Pulse short ID test key",
        permission: "write",
      });
      expect(createdKey.ok).toBe(true);
      if (!createdKey.ok) throw new Error(createdKey.error.message);
      const [boundSourceAccount] = await sql<{ id: string; resource_id: string }[]>`
        SELECT id, resource_id
        FROM auth.service_accounts
        WHERE kind = 'resource_bound'
          AND app_id = 'pulse'
          AND resource_type = 'pulse_source'
          AND resource_id = ${sourceShortId}
      `;
      expect(boundSourceAccount?.resource_id).toBe(sourceShortId);

      const keys = await listSourceApiKeys({ baseId, sourceId, user });
      expect(keys.ok).toBe(true);
      if (keys.ok) expect(keys.data.map((key) => key.id)).toContain(createdKey.data.credential.id);

      const removedKey = await removeSourceApiKey({
        baseId,
        sourceId,
        credentialId: createdKey.data.credential.id,
        user,
      });
      expect(removedKey.ok).toBe(true);

      const replacementKey = await createSourceApiKey({
        baseId,
        sourceId,
        user,
        name: "Pulse source cleanup test key",
        permission: "write",
      });
      expect(replacementKey.ok).toBe(true);

      const removedSource = await removeSource({ baseId, sourceId, user });
      if (!removedSource.ok) throw new Error(removedSource.error.message);
      const [remainingSourceAccount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM auth.service_accounts
        WHERE kind = 'resource_bound'
          AND app_id = 'pulse'
          AND resource_type = 'pulse_source'
          AND resource_id = ${sourceShortId}
      `;
      expect(remainingSourceAccount?.count).toBe(0);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id IN (${baseId}::uuid, ${noneBaseId}::uuid)`;
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
      await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${parentGroupId}::uuid OR child_group_id = ${childGroupId}::uuid`;
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${baseServiceAccountId}::uuid, ${sourceServiceAccountId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
