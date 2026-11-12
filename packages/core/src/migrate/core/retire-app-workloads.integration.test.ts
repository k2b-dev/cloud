import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { APP_KEY_FIXTURES } from "../../../../../scripts/fixtures/app-key-fixtures";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "./audit";
import { migrate as migrateAuth } from "./auth";
import { retireAppWorkloads } from "./retire-app-workloads";

const suite = databaseSuite();
suite("app identity cutover", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("app_identity_cutover");
    await migrateAuth();
    await migrateAudit();
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("revokes only former app API credentials and audits each once across repeated migrations", async () => {
    const [app] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Cutover app', 'resource_bound', 'cutover', 'cloud.app', 'cutover') RETURNING id`;
    const [resource] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Object', 'resource_bound', 'cutover', 'cutover.item', 'one') RETURNING id`;
    const [standalone] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Independent', 'standalone') RETURNING id`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES ('cutover-user', 'local', 'user') RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    const [personal] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES ('Personal', 'user_delegated', ${user.id}::uuid) RETURNING id`;
    if (!app || !resource || !standalone || !personal) throw new Error("Missing fixture account");
    const newToken = await serviceAccountCredentials.createResourceApiToken({
      serviceAccountId: app.id,
      actor: buildProjectedUser({ id: user.id, uid: "cutover-user", provider: "local", profile: "user" }),
      name: "App API token",
    });
    expect(newToken.ok).toBe(false);
    if (!newToken.ok) expect(newToken.error.code).toBe("BAD_INPUT");
    const retired: string[] = [];
    const retained: string[] = [];
    for (const [account, scope, shouldRetire] of [
      [app.id, "identity:invoke", true],
      [app.id, "identity:oauth-issue", true],
      [app.id, "read", false],
      [resource.id, "identity:invoke", false],
      [standalone.id, "identity:invoke", false],
      [personal.id, "identity:invoke", false],
    ] as const) {
      const [key] = await sql<{ id: string }[]>`INSERT INTO auth.service_account_credentials
        (service_account_id, name, kind, token_prefix, secret_hash, scopes)
        VALUES (${account}::uuid, 'Fixture', 'api_token', ${crypto.randomUUID()}, 'fixture-hash', ARRAY[${scope}]::text[]) RETURNING id`;
      if (!key) throw new Error("Missing fixture credential");
      (shouldRetire ? retired : retained).push(key.id);
    }
    const [appKey] = await sql<{ id: string }[]>`INSERT INTO auth.service_account_credentials
      (service_account_id, name, kind, public_key, fingerprint) VALUES
      (${app.id}::uuid, 'Signed identity', 'app_key', ${APP_KEY_FIXTURES[0].publicKey}, ${APP_KEY_FIXTURES[0].fingerprint}) RETURNING id`;
    if (!appKey) throw new Error("Missing fixture app key");
    retained.push(appKey.id);
    await retireAppWorkloads();
    await retireAppWorkloads();
    for (const id of retired) {
      const [row] = await sql<
        { status: string; revoked_at: Date | null }[]
      >`SELECT status, revoked_at FROM auth.service_account_credentials WHERE id = ${id}::uuid`;
      expect(row?.status).toBe("revoked");
      expect(row?.revoked_at).not.toBeNull();
      const rows = await sql<{ action: string; reason: string }[]>`SELECT action, reason FROM audit.events WHERE target_id = ${id}`;
      expect(rows).toEqual([{ action: "service_account_credential.revoke", reason: "app_key_cutover" }]);
    }
    for (const id of retained) {
      const [row] = await sql<{ status: string }[]>`SELECT status FROM auth.service_account_credentials WHERE id = ${id}::uuid`;
      expect(row?.status).toBe("active");
      expect(await sql`SELECT id FROM audit.events WHERE target_id = ${id}`).toHaveLength(0);
    }
  });
});
