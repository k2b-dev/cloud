import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import recordsRoutes from "./records";
import tablesRoutes from "./tables";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const app = new Hono<AuthContext>().route("/tables", tablesRoutes).route("/records", recordsRoutes);

const bearer = (token: string, method = "GET"): RequestInit => ({ method, headers: { authorization: `Bearer ${token}` } });

describe("durable history route permissions", () => {
  postgresTest("keeps activation admin-only and returns public-only versions through the normal record gate", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const foreignBaseId = testUuid();
    const tableId = testUuid();
    const foreignTableId = testUuid();
    const fieldId = testUuid();
    const fileFieldId = testUuid();
    const fileId = testUuid();
    const recordId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const foreignTableShortId = testShortId("X");
    const fieldShortId = testShortId("F");
    const fileFieldShortId = testShortId("L");
    const fileShortId = testShortId("I");
    const recordShortId = testShortId("R");
    const user: User = {
      id: userId,
      uid: `durable-history-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Durable",
      sn: "History",
      displayName: "Durable History",
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    let serviceAccountId: string | null = null;
    let accessId: string | null = null;
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${user.uid}, 'local', 'user', ${user.displayName}, ${user.givenname}, ${user.sn})
      `;
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES
          (${baseId}::uuid, ${baseShortId}, 'Durable routes'),
          (${foreignBaseId}::uuid, ${testShortId("C")}, 'Foreign durable routes')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES
          (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Assets'),
          (${foreignTableId}::uuid, ${foreignTableShortId}, ${foreignBaseId}::uuid, 'Foreign assets')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
        VALUES
          (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE),
          (${fileFieldId}::uuid, ${fileFieldShortId}, ${tableId}::uuid, 'Attachment', 'file', '{}'::jsonb, 1, FALSE)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [fieldId]: "Camera" }}::jsonb)
      `;
      await sql`
        INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
        VALUES (${fileId}::uuid, ${fileShortId}, 'history.txt', 'text/plain', 10, 'history-sha', ${new TextEncoder().encode("historical")})
      `;
      await sql`
        INSERT INTO grids.file_attachments (file_id, record_id, field_id, position)
        VALUES (${fileId}::uuid, ${recordId}::uuid, ${fileFieldId}::uuid, 0)
      `;

      const account = await serviceAccounts.getOrCreateResourceBound({
        name: "Grids durable history route test",
        appId: "grids",
        resourceType: "base",
        resourceId: baseId,
        createdBy: userId,
      });
      if (!account.ok) throw account.error;
      serviceAccountId = account.data.id;
      accessId = testUuid();
      await sql`
        INSERT INTO auth.access (id, service_account_id, permission)
        VALUES (${accessId}::uuid, ${serviceAccountId}::uuid, 'admin'::auth.permission_level)
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      const readCredential = await serviceAccountCredentials.createResourceApiToken({
        serviceAccountId,
        actor: user,
        name: "Durable history read",
        scopes: ["grids:read"],
      });
      const adminCredential = await serviceAccountCredentials.createResourceApiToken({
        serviceAccountId,
        actor: user,
        name: "Durable history admin",
        scopes: ["grids:admin"],
      });
      const writeCredential = await serviceAccountCredentials.createResourceApiToken({
        serviceAccountId,
        actor: user,
        name: "Record finalization write",
        scopes: ["grids:write"],
      });
      if (!readCredential.ok || !writeCredential.ok || !adminCredential.ok) throw new Error("credential creation failed");

      expect((await app.request(`/tables/${tableShortId}/durable-history`)).status).toBe(401);
      expect((await app.request(`/tables/${tableShortId}/durable-history`, bearer(readCredential.data.token))).status).toBe(403);
      expect((await app.request(`/tables/${foreignTableShortId}/durable-history`, bearer(adminCredential.data.token))).status).toBe(403);

      const enabled = await app.request(`/tables/${tableShortId}/durable-history/enable`, bearer(adminCredential.data.token, "POST"));
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ enabled: true, status: "active", baseline: { captured: 1, total: 1 } });

      const versions = await app.request(`/records/${tableShortId}/${recordShortId}/versions?limit=5`, bearer(readCredential.data.token));
      expect(versions.status).toBe(200);
      const versionPage = (await versions.json()) as {
        items: Array<{ data: Record<string, unknown>; files: Array<{ id: string }>; id: string }>;
      };
      expect(versionPage.items).toHaveLength(1);
      expect(versionPage.items[0]?.data).toEqual({ [fieldShortId]: "Camera" });
      expect(versionPage.items[0]?.files).toEqual([expect.objectContaining({ id: fileShortId })]);
      const serialized = JSON.stringify(versionPage);
      expect(serialized).not.toContain(tableId);
      expect(serialized).not.toContain(recordId);
      expect(serialized).not.toContain(fieldId);
      expect(serialized).not.toContain(userId);

      expect((await app.request(`/tables/${tableShortId}/finalization`, bearer(readCredential.data.token))).status).toBe(403);
      const finalizationEnabled = await app.request(`/tables/${tableShortId}/finalization/enable`, {
        ...bearer(adminCredential.data.token, "POST"),
        headers: { authorization: `Bearer ${adminCredential.data.token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      expect(finalizationEnabled.status).toBe(200);
      expect(await finalizationEnabled.json()).toMatchObject({ enabled: true, finalizedCount: 0, canDisable: true });
      expect((await app.request(`/records/${tableShortId}/${recordShortId}/finalization`, bearer(readCredential.data.token))).status).toBe(
        403,
      );
      const readiness = await app.request(`/records/${tableShortId}/${recordShortId}/finalization`, bearer(writeCredential.data.token));
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ enabled: true, finalized: false, missing: [] });
      const finalized = await app.request(`/records/${tableShortId}/${recordShortId}/finalize`, bearer(writeCredential.data.token, "POST"));
      expect(finalized.status).toBe(200);
      const finalizedBody = (await finalized.json()) as { id: string; tableId: string; finalizedAt: string };
      expect(finalizedBody.id).toBe(recordShortId);
      expect(finalizedBody.tableId).toBe(tableShortId);
      expect(typeof finalizedBody.finalizedAt).toBe("string");
      expect(JSON.stringify(finalizedBody)).not.toContain(recordId);
      expect(
        (
          await app.request(`/records/${tableShortId}/${recordShortId}`, {
            ...bearer(writeCredential.data.token, "PATCH"),
            headers: { authorization: `Bearer ${writeCredential.data.token}`, "content-type": "application/json" },
            body: JSON.stringify({ values: { [fieldShortId]: "Changed" } }),
          })
        ).status,
      ).toBe(409);

      await sql`DELETE FROM grids.file_attachments WHERE file_id = ${fileId}::uuid`;
      const fileUrl = `/records/${tableShortId}/${recordShortId}/versions/${versionPage.items[0]!.id}/files/${fileShortId}`;
      expect((await app.request(fileUrl)).status).toBe(401);
      const historicalFile = await app.request(fileUrl, bearer(readCredential.data.token));
      expect(historicalFile.status).toBe(200);
      expect(historicalFile.headers.get("cache-control")).toBe("private, no-store");
      expect(await historicalFile.text()).toBe("historical");

      const normalRecord = await app.request(`/records/${tableShortId}/${recordShortId}`, bearer(readCredential.data.token));
      expect(normalRecord.status).toBe(200);
      expect(await normalRecord.json()).not.toHaveProperty("versions");
      expect(
        (await app.request(`/records/${tableShortId}/${recordShortId}/versions?cursor=bad`, bearer(readCredential.data.token))).status,
      ).toBe(400);
    } finally {
      await sql`
        UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL
        WHERE table_id = ${tableId}::uuid
      `;
      await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.record_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.audit_log WHERE base_id IN (${baseId}::uuid, ${foreignBaseId}::uuid)`;
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${foreignBaseId}::uuid)`;
      await sql`DELETE FROM grids.files WHERE id = ${fileId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
