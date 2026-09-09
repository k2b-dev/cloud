import { beforeAll, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import evidenceExportRoutes from "./evidence-exports";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const app = new Hono<AuthContext>().route("/evidence-exports", evidenceExportRoutes);
const bearer = (token: string, method = "GET"): RequestInit => ({ method, headers: { authorization: `Bearer ${token}` } });

describe("evidence export route permissions", () => {
  postgresTest("keeps preflight, jobs, and package metadata behind the Base admin gate", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const exportId = testUuid();
    const exportShortId = testShortId("E");
    const packageBytes = new TextEncoder().encode("tar");
    const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
    const user: User = {
      id: userId,
      uid: `evidence-routes-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Evidence",
      sn: "Routes",
      displayName: "Evidence Routes",
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
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Evidence route permissions')`;
      await sql`
        INSERT INTO grids.evidence_exports (
          id, short_id, base_id, sections, status, package_filename, package_size_bytes,
          package_sha256, manifest_sha256, manifest, completed_at, expires_at
        ) VALUES (
          ${exportId}::uuid, ${exportShortId}, ${baseId}::uuid, ARRAY['records'], 'completed', 'evidence.tar',
          ${packageBytes.byteLength}, ${packageSha256}, ${"b".repeat(64)}, '{}'::jsonb, now(), now() + interval '1 day'
        )
      `;
      await sql`INSERT INTO grids.evidence_export_chunks (export_id, sequence, bytes) VALUES (${exportId}::uuid, 0, ${packageBytes})`;
      const account = await serviceAccounts.getOrCreateResourceBound({
        name: "Grids evidence export route test",
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
        name: "Evidence read",
        scopes: ["grids:read"],
      });
      const adminCredential = await serviceAccountCredentials.createResourceApiToken({
        serviceAccountId,
        actor: user,
        name: "Evidence admin",
        scopes: ["grids:admin"],
      });
      if (!readCredential.ok || !adminCredential.ok) throw new Error("credential creation failed");

      const url = `/evidence-exports/by-base/${baseShortId}`;
      expect((await app.request(`${url}/preflight`)).status).toBe(401);
      expect((await app.request(`${url}/preflight`, bearer(readCredential.data.token))).status).toBe(403);
      expect((await app.request(url, bearer(readCredential.data.token))).status).toBe(403);
      expect((await app.request(`/evidence-exports/${exportShortId}`, bearer(readCredential.data.token))).status).toBe(404);
      expect((await app.request(`/evidence-exports/${exportShortId}/download`, bearer(readCredential.data.token))).status).toBe(404);
      expect(
        (
          await app.request(url, {
            ...bearer(readCredential.data.token, "POST"),
            headers: { authorization: `Bearer ${readCredential.data.token}`, "content-type": "application/json" },
            body: JSON.stringify({ sections: ["records"] }),
          })
        ).status,
      ).toBe(403);

      const preflight = await app.request(`${url}/preflight?sections=records,revisions`, bearer(adminCredential.data.token));
      expect(preflight.status).toBe(200);
      expect(await preflight.json()).toMatchObject({
        scope: { baseId: baseShortId, tableId: null },
        known: { numberSeries: 0, numberSeriesVersions: 0, numberAllocations: 0 },
        tables: [],
        withinKnownBudgets: true,
      });
      const listed = await app.request(url, bearer(adminCredential.data.token));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ items: [{ id: exportShortId, baseId: baseShortId, status: "completed" }] });
      const inspected = await app.request(`/evidence-exports/${exportShortId}`, bearer(adminCredential.data.token));
      expect(inspected.status).toBe(200);
      expect(JSON.stringify(await inspected.json())).not.toContain(exportId);
      const downloaded = await app.request(`/evidence-exports/${exportShortId}/download`, bearer(adminCredential.data.token));
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
      expect(downloaded.headers.get("etag")).toBe(`"${packageSha256}"`);
      expect(await downloaded.text()).toBe("tar");
      expect((await app.request(`/evidence-exports/${testShortId("X")}`, bearer(adminCredential.data.token))).status).toBe(404);
      expect((await app.request(`/evidence-exports/by-base/${baseId}`, bearer(adminCredential.data.token))).status).toBe(404);
      expect((await app.request(`${url}/preflight?sections=records,unknown`, bearer(adminCredential.data.token))).status).toBe(400);
      expect((await app.request(`${url}/preflight?sections=records,records`, bearer(adminCredential.data.token))).status).toBe(400);
    } finally {
      await sql`DELETE FROM grids.evidence_exports WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
