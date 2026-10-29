import "../../../scripts/fixtures/test-infra";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { APP_REGISTRY_CONFIG, appRegistry, bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts/shared";
import { authenticateWorkloadCredential } from "@k2b/cloud/services/identity";
import {
  issueAppWorkloadCredential,
  revokeRemovedAppWorkloads,
  startAppWorkloadBroker,
} from "@k2b/cloud/services/identity/workload-runtime";
import { serviceAccountCredentials } from "@k2b/cloud/services/service-account-credentials";
import { createSync } from "@k2b/sync";
import { sql } from "bun";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateAuth } from "./migrate/core/auth";

const suite = suiteFor("database", "nats");
const appId = "third-party-inventory";
const instanceId = "0123456789abcdef";
const admin: User = {
  id: "12345678-1234-4234-8234-123456789abc",
  uid: "workload-admin",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Admin",
  displayName: "Test Admin",
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
const request = { operation: "refresh", appId, instanceId, credentialId: null } as const;
const namespace = testSyncNamespace("app-workload");
const subject = `cloud.workload.${createHash("sha256").update(namespace).digest("hex")}.v1`;
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
let sync: ReturnType<typeof createSync> | undefined;
let stopBroker: (() => Promise<void>) | undefined;
const instanceKey = `instances/${createHash("sha256").update(appId).digest("base64url").slice(0, 16)}/${instanceId}`;

suite("Core automatic app workload credentials", () => {
  beforeAll(async () => {
    database = await useFreshDatabase("app_workload");
    await migrateAuth();
    await migrateAudit();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES (${admin.id}::uuid, ${admin.uid}, 'local', 'user', 'Test Admin')`;
    connection = await connectTestNats({ timeout: 3_000, maxReconnectAttempts: 0 });
    sync = createSync({ connection, namespace, application: "workload-test", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
  }, 30_000);
  afterAll(async () => {
    await stopBroker?.();
    await sync?.drain();
    unbindProcessSync();
    await connection?.close();
    await sql.close();
    await database?.drop();
  });

  test("issues only registered app material over non-retained NATS, hashes storage, rotates, honours revoke, and revokes removed instances", async () => {
    if (!connection || !sync) throw new Error("test transport missing");
    const instances = sync.ephemeral<{ appId: string; instanceId: string }>(APP_REGISTRY_CONFIG);
    await appRegistry().upsert({
      key: `apps/${appId}`,
      value: {
        id: appId,
        name: "Inventory",
        icon: "box",
        description: "Test",
        baseUrl: "http://inventory:3000",
        routes: ["/api/inventory"],
      },
    });
    await instances.upsert({ key: instanceKey, value: { appId, instanceId } });
    stopBroker = await startAppWorkloadBroker({ connection, namespace });
    const response = await connection.request(subject, JSON.stringify(request), { timeout: 5_000 });
    const delivered: unknown = response.json<unknown>();
    const issued = await issueAppWorkloadCredential(request);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("issuance failed");
    // The second request intentionally simulates a lost delivery acknowledgement. The first
    // credential must be revoked, with exactly one active credential remaining for this instance.
    expect(delivered).toMatchObject({ status: "issued", appId, instanceId });
    expect(Object.keys(delivered ?? {}).sort()).toEqual(["appId", "credentialId", "expiresAt", "instanceId", "status", "token"]);
    const invalid = await connection.request(subject, JSON.stringify({ ...request, scopes: ["identity:oauth-issue"] }), { timeout: 5_000 });
    expect(invalid.json<unknown>()).toEqual({ status: "unavailable" });
    const [count] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM auth.service_account_credentials WHERE status = 'active'`;
    expect(count?.count).toBe(1);
    const authenticated = await authenticateWorkloadCredential({ token: issued.token, appId, scope: "identity:invoke" });
    expect(authenticated?.credentialId).toBe(issued.credentialId);
    expect(await authenticateWorkloadCredential({ token: issued.token, appId: "other-app", scope: "identity:invoke" })).toBeNull();
    const [stored] = await sql<
      { secret_hash: string; scopes: string[]; delegated_user_id: string | null; resource_type: string; resource_id: string }[]
    >`
      SELECT c.secret_hash, c.scopes, sa.delegated_user_id, sa.resource_type, sa.resource_id
      FROM auth.service_account_credentials c JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.id = ${issued.credentialId}::uuid
    `;
    expect(stored?.secret_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(stored?.secret_hash).not.toContain(issued.token);
    expect(stored).toMatchObject({ scopes: ["identity:invoke"], delegated_user_id: null, resource_type: "cloud.app", resource_id: appId });
    expect(await issueAppWorkloadCredential({ ...request, credentialId: issued.credentialId })).toEqual({
      status: "current",
      credentialId: issued.credentialId,
    });
    await sql`UPDATE auth.service_account_credentials SET expires_at = now() + interval '10 minutes' WHERE id = ${issued.credentialId}::uuid`;
    const rotated = await issueAppWorkloadCredential({ ...request, credentialId: issued.credentialId });
    expect(rotated.status).toBe("issued");
    if (rotated.status !== "issued") throw new Error("rotation failed");
    expect(rotated.token).not.toBe(issued.token);
    expect((await authenticateWorkloadCredential({ token: issued.token, appId, scope: "identity:invoke" }))?.credentialId).toBe(
      issued.credentialId,
    );
    expect((await authenticateWorkloadCredential({ token: rotated.token, appId, scope: "identity:invoke" }))?.credentialId).toBe(
      rotated.credentialId,
    );
    // A lost rotation reply replaces the undelivered generation, preserving the caller's old token.
    const recoveredRotation = await issueAppWorkloadCredential({ ...request, credentialId: issued.credentialId });
    if (recoveredRotation.status !== "issued") throw new Error("lost rotation reply recovery failed");
    expect((await authenticateWorkloadCredential({ token: issued.token, appId, scope: "identity:invoke" }))?.credentialId).toBe(
      issued.credentialId,
    );
    expect(await authenticateWorkloadCredential({ token: rotated.token, appId, scope: "identity:invoke" })).toBeNull();
    let latest = recoveredRotation;
    for (let rotation = 0; rotation < 3; rotation++) {
      await sql`UPDATE auth.service_account_credentials SET expires_at = now() + interval '10 minutes' WHERE id = ${latest.credentialId}::uuid`;
      const next = await issueAppWorkloadCredential({ ...request, credentialId: latest.credentialId });
      if (next.status !== "issued") throw new Error("repeated rotation failed");
      latest = next;
      const [bounded] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.service_account_credentials`;
      expect(bounded?.count).toBe(2);
    }
    // Both lock orders must honour revocation of the credential the administrator saw.
    await sql`UPDATE auth.service_account_credentials SET expires_at = now() + interval '10 minutes' WHERE id = ${latest.credentialId}::uuid`;
    const [racingRotation, revoked] = await Promise.all([
      issueAppWorkloadCredential({ ...request, credentialId: latest.credentialId }),
      serviceAccountCredentials.revoke({ credentialId: latest.credentialId, actor: admin }),
    ]);
    expect(revoked.ok).toBe(true);
    if (racingRotation.status === "issued") {
      expect(await authenticateWorkloadCredential({ token: racingRotation.token, appId, scope: "identity:invoke" })).toBeNull();
    } else expect(racingRotation.status).toBe("revoked");
    expect(await authenticateWorkloadCredential({ token: latest.token, appId, scope: "identity:invoke" })).toBeNull();
    expect(await issueAppWorkloadCredential(request)).toEqual({ status: "revoked" });
    expect(await issueAppWorkloadCredential({ ...request, appId: "not-registered" })).toEqual({ status: "unregistered" });

    const nextInstance = "fedcba9876543210";
    const nextKey = instanceKey.replace(instanceId, nextInstance);
    await instances.upsert({ key: nextKey, value: { appId, instanceId: nextInstance } });
    const next = await issueAppWorkloadCredential({ ...request, instanceId: nextInstance });
    if (next.status !== "issued") throw new Error("new instance issuance failed");
    // Removing one replica must revoke it even while the shared app entry remains live.
    await instances.delete({ key: nextKey });
    await revokeRemovedAppWorkloads();
    expect(await authenticateWorkloadCredential({ token: next.token, appId, scope: "identity:invoke" })).toBeNull();

    // A live process heals its membership after a registry reset without bypassing an admin revoke.
    await instances.upsert({ key: nextKey, value: { appId, instanceId: nextInstance } });
    const recovered = await issueAppWorkloadCredential({ ...request, instanceId: nextInstance });
    expect(recovered.status).toBe("issued");
    expect(await issueAppWorkloadCredential(request)).toEqual({ status: "revoked" });

    const lastInstance = "abcdef0123456789";
    const lastKey = instanceKey.replace(instanceId, lastInstance);
    await instances.upsert({ key: lastKey, value: { appId, instanceId: lastInstance } });
    const last = await issueAppWorkloadCredential({ ...request, instanceId: lastInstance });
    if (last.status !== "issued") throw new Error("last instance issuance failed");
    expect(
      await issueAppWorkloadCredential({ ...request, operation: "release", instanceId: lastInstance, credentialId: last.credentialId }),
    ).toEqual({ status: "revoked" });
    expect(await authenticateWorkloadCredential({ token: last.token, appId, scope: "identity:invoke" })).toBeNull();
    await appRegistry().delete({ key: `apps/${appId}` });
    expect(await issueAppWorkloadCredential({ ...request, instanceId: lastInstance })).toEqual({ status: "unregistered" });
  }, 30_000);
});
