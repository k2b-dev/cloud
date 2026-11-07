import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { audit } from "./audit";
import { issueAppWorkloadCredential } from "./identity/workload-runtime";
import { serviceAccountCredentials } from "./service-account-credentials";
import { serviceAccounts } from "./service-accounts";
import { buildProjectedUser } from "./session/user";

const suite = databaseSuite();
const now = new Date("2026-11-03T12:00:00.000Z");

suite("automatic rows in administrator lists", () => {
  beforeEach(() => setSystemTime(now));
  afterEach(() => setSystemTime());

  test("overview hides current, overlapping and revoked runtime keys without matching names or scopes", async () => {
    const marker = crypto.randomUUID();
    const appId = `overview-${marker}`;
    const request = { operation: "refresh", appId, instanceId: "0123456789abcdef", credentialId: null } as const;
    const accounts: string[] = [];
    const admin = buildProjectedUser({ id: crypto.randomUUID(), uid: `admin-${marker}`, provider: "local", profile: "user" });
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${admin.id}::uuid, ${admin.uid}, 'local', 'user')`;
      const issued = await issueAppWorkloadCredential(request, async () => true);
      if (issued.status !== "issued") throw new Error("Runtime fixture issuance failed");
      const account = await serviceAccounts.getByResource({ appId, resourceType: "cloud.app", resourceId: appId });
      if (!account) throw new Error("Runtime fixture account missing");
      accounts.push(account.id);
      const resource = await serviceAccounts.createResourceBound({ name: marker, appId, resourceType: "fixture", resourceId: marker });
      const agent = await serviceAccounts.createStandalone({ name: `Agent ${marker}`, kind: "agent" });
      if (!resource.ok || !agent.ok) throw new Error("Account fixture creation failed");
      accounts.push(resource.data.id, agent.data.id);
      const visibleIds: string[] = [];
      for (const serviceAccountId of accounts) {
        const key = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: "Runtime foo", scopes: ["identity:invoke"] });
        if (!key.ok) throw new Error("Manual fixture key creation failed");
        visibleIds.push(key.data.credential.id);
      }
      // Force rotation with overlap; both generations must be hidden.
      await sql`UPDATE auth.service_account_credentials SET expires_at = ${new Date(now.getTime() + 60_000)} WHERE id = ${issued.credentialId}::uuid`;
      const rotated = await issueAppWorkloadCredential({ ...request, credentialId: issued.credentialId }, async () => true);
      if (rotated.status !== "issued") throw new Error("Runtime fixture rotation failed");

      const hidden = await serviceAccountCredentials.listOverview({
        filter: { automatic: "hide", search: marker, credentialStatus: "active" },
      });
      expect(hidden.total).toBe(3);
      expect(hidden.hiddenAutomaticCount).toBe(2);
      expect(hidden.items.map((item) => item.id).sort()).toEqual(visibleIds.sort());
      const firstPage = await serviceAccountCredentials.listOverview({
        pagination: { perPage: 1 },
        filter: { automatic: "hide", search: marker },
      });
      expect(firstPage).toMatchObject({ total: 3, hiddenAutomaticCount: 2, hasNext: true });
      expect(firstPage.items).toHaveLength(1);
      const included = await serviceAccountCredentials.listOverview({ filter: { search: marker, automatic: "include" } });
      expect(included.total).toBe(5);
      expect(included.items.map((item) => item.id)).toEqual(expect.arrayContaining([issued.credentialId, rotated.credentialId]));
      expect(included).not.toHaveProperty("hiddenAutomaticCount");
      // Other callers keep today's list: hiding is opt-in.
      expect(await serviceAccountCredentials.listOverview({ filter: { search: marker } })).toEqual(included);
      const agents = await serviceAccountCredentials.listOverview({
        filter: { automatic: "hide", search: marker, serviceAccountKind: "agent" },
      });
      expect(agents).toMatchObject({ total: 1, hiddenAutomaticCount: 0 });
      const unrelated = await serviceAccountCredentials.listOverview({ filter: { automatic: "hide", search: `missing-${marker}` } });
      expect(unrelated).toMatchObject({ total: 0, hiddenAutomaticCount: 0 });

      const stopping = await issueAppWorkloadCredential({ ...request, instanceId: "fedcba9876543210" }, async () => true);
      if (stopping.status !== "issued") throw new Error("Stopping runtime fixture issuance failed");
      expect(await serviceAccountCredentials.listOverview({ filter: { automatic: "hide", search: marker } })).toMatchObject({
        total: 3,
        hiddenAutomaticCount: 3,
      });
      await issueAppWorkloadCredential(
        { ...request, operation: "release", instanceId: "fedcba9876543210", credentialId: stopping.credentialId },
        async () => true,
      );
      expect(await serviceAccountCredentials.getOverview({ id: stopping.credentialId })).toBeNull();
      expect(await serviceAccountCredentials.listOverview({ filter: { automatic: "hide", search: marker } })).toMatchObject({
        total: 3,
        hiddenAutomaticCount: 2,
      });

      expect((await serviceAccountCredentials.revoke({ credentialId: rotated.credentialId, actor: admin })).ok).toBe(true);
      const revoked = await serviceAccountCredentials.listOverview({
        filter: { automatic: "hide", search: marker, credentialStatus: "revoked" },
      });
      expect(revoked).toMatchObject({ total: 0, hiddenAutomaticCount: 2 });
      const revokedIncluded = await serviceAccountCredentials.listOverview({
        filter: { search: marker, credentialStatus: "revoked", automatic: "include" },
      });
      expect(revokedIncluded.total).toBe(2);
      // An admin-revoked instance keeps its mapping even when it subsequently stops.
      await issueAppWorkloadCredential({ ...request, operation: "release", credentialId: rotated.credentialId }, async () => true);
      expect(await serviceAccountCredentials.listOverview({ filter: { automatic: "hide", search: marker } })).toMatchObject({
        total: 3,
        hiddenAutomaticCount: 2,
      });
    } finally {
      await sql`DELETE FROM auth.app_workload_instances WHERE app_id = ${appId}`;
      for (const id of accounts) {
        await sql`DELETE FROM audit.events WHERE metadata->>'serviceAccountId' = ${id}`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
      await sql`DELETE FROM auth.users WHERE id = ${admin.id}::uuid`;
    }
  });

  test("audit hides only system app-workload entries and counts within the selected time and filters", async () => {
    const marker = crypto.randomUUID();
    const metadata = [
      {},
      { provenance: "system" },
      { service: "app-workload" },
      { provenance: "user", service: "app-workload" },
      { provenance: "system", service: "another-service" },
      { provenance: "system", service: "app-workload" },
    ];
    try {
      for (const entry of metadata) {
        await audit.record({
          action: "service_account_credential.create",
          outcome: "allowed",
          target: { id: marker },
          requestId: marker,
          metadata: entry,
        });
      }
      await sql`
        INSERT INTO audit.events (action, outcome, target_id, request_id, metadata, created_at)
        VALUES ('service_account_credential.create', 'allowed', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now() - interval '31 days'),
          ('service_account_credential.revoke', 'allowed', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now()),
          ('service_account_credential.create', 'denied', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now())
      `;
      const filter = { target: marker, days: 30, action: "service_account_credential.create", outcome: "allowed" } as const;
      const hidden = await audit.list({ filter: { ...filter, automatic: "hide" }, pagination: { perPage: 2 } });
      expect(hidden).toMatchObject({ total: 5, hiddenAutomaticCount: 1, hasNext: true });
      expect(hidden.items).toHaveLength(2);
      const included = await audit.list({ filter: { ...filter, automatic: "include" } });
      expect(included.total).toBe(6);
      const allHidden = await audit.list({ filter: { ...filter, automatic: "hide" } });
      expect(allHidden.items.map((item) => item.id)).toEqual(
        included.items
          .filter((item) => !(item.metadata.provenance === "system" && item.metadata.service === "app-workload"))
          .map((item) => item.id),
      );
      expect(allHidden.items).toHaveLength(5);
      expect(included).not.toHaveProperty("hiddenAutomaticCount");
      expect(await audit.list({ filter })).toEqual(included);
      expect(await audit.list({ filter: { ...filter, target: `missing-${marker}`, automatic: "hide" } })).toMatchObject({
        total: 0,
        hiddenAutomaticCount: 0,
      });
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${marker}`;
    }
  });
});
