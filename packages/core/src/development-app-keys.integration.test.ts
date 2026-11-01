import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { env } from "@k2b/cloud/config";
import {
  DEVELOPMENT_APP_KEYS,
  DEVELOPMENT_INSTALLATION_ID,
  getActiveAppKey,
  listAppKeys,
  listAppsWithKeys,
  registerAppKey,
} from "@k2b/cloud/services/app-keys";
import { listActiveMigrationKeys } from "@k2b/cloud/services/app-migration";
import { APP_KEY_FIXTURES } from "../../../scripts/fixtures/app-key-fixtures";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateAuth } from "./migrate/core/auth";
import { enrollDevelopmentAppKeys } from "./migrate/core/development-app-keys";

databaseSuite()("isolated development app enrollment", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("cloud_app_key_dev_r3");
    await migrateAuth();
    await migrateAudit();
  });
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });
  const enroll = () => enrollDevelopmentAppKeys(sql, { enabled: true, mode: "development" });
  test("fresh and preexisting databases enroll once, retain their data, and preserve revoked or disabled state", async () => {
    await sql`INSERT INTO auth.users (id, uid, provider, profile, admin) VALUES ('11111111-1111-4111-8111-111111111111'::uuid, 'kept-user', 'local', 'user', true)`;
    const custom = DEVELOPMENT_APP_KEYS[0]!;
    const oauth = DEVELOPMENT_APP_KEYS.find((key) => key.appId === "oauth")!;
    const customGrants = Object.getOwnPropertyDescriptor(custom, "grants")!;
    const oauthGrants = Object.getOwnPropertyDescriptor(oauth, "grants")!;
    Object.defineProperty(custom, "grants", { value: ["oauth:issue"], configurable: true });
    Object.defineProperty(oauth, "grants", { value: [], configurable: true });
    try {
      await enroll();
      await enroll();
    } finally {
      Object.defineProperty(custom, "grants", customGrants);
      Object.defineProperty(oauth, "grants", oauthGrants);
    }
    expect((await sql<{ id: string }[]>`SELECT id FROM auth.installation`)[0]?.id).toBe(DEVELOPMENT_INSTALLATION_ID);
    expect(
      (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.service_account_credentials WHERE kind = 'app_key'`)[0]
        ?.count,
    ).toBe(DEVELOPMENT_APP_KEYS.length);
    expect((await sql`SELECT uid FROM auth.users WHERE uid = 'kept-user'`).length).toBe(1);
    const grants = await sql<{ app_id: string; oauth_issue_allowed: boolean }[]>`SELECT sa.app_id, c.oauth_issue_allowed
      FROM auth.service_account_credentials c JOIN auth.service_accounts sa ON sa.id = c.service_account_id WHERE c.kind = 'app_key'`;
    for (const key of DEVELOPMENT_APP_KEYS)
      expect(grants.find((row) => row.app_id === key.appId)?.oauth_issue_allowed).toBe(key.appId === custom.appId);
    const key = DEVELOPMENT_APP_KEYS[0]!;
    await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${key.keyId}::uuid`;
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE app_id = ${key.appId}`;
    await enroll();
    expect(
      (await sql<{ status: string }[]>`SELECT status FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid`)[0]?.status,
    ).toBe("revoked");
    expect((await sql<{ status: string }[]>`SELECT status FROM auth.service_accounts WHERE app_id = ${key.appId}`)[0]?.status).toBe(
      "disabled",
    );
  });
  test("migration inventory ignores revoked, expired and disabled keys but keeps active stopped apps", async () => {
    const expired = DEVELOPMENT_APP_KEYS[2]!;
    const disabled = DEVELOPMENT_APP_KEYS[3]!;
    await sql`UPDATE auth.service_account_credentials SET expires_at = created_at - interval '1 second' WHERE id = ${expired.keyId}::uuid`;
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE app_id = ${disabled.appId}`;
    const previous = Object.getOwnPropertyDescriptor(env, "NODE_ENV")!;
    Object.defineProperty(env, "NODE_ENV", { value: "development", configurable: true });
    try {
      const active = await listActiveMigrationKeys(sql);
      expect(active.some((key) => key.keyId === DEVELOPMENT_APP_KEYS[0]!.keyId)).toBe(false);
      expect(active.some((key) => key.keyId === expired.keyId)).toBe(false);
      expect(active.some((key) => key.keyId === disabled.keyId)).toBe(false);
      expect(active.some((key) => key.keyId === DEVELOPMENT_APP_KEYS[1]!.keyId)).toBe(true);
    } finally {
      Object.defineProperty(env, "NODE_ENV", previous);
    }
  });
  test("production refuses enrollment and active development public keys even after a database restore", async () => {
    await expect(enrollDevelopmentAppKeys(sql, { enabled: true, mode: "production" })).rejects.toThrow("requires NODE_ENV");
    const previous = Object.getOwnPropertyDescriptor(env, "NODE_ENV")!;
    Object.defineProperty(env, "NODE_ENV", { value: "production", configurable: true });
    try {
      const key = DEVELOPMENT_APP_KEYS[1]!;
      expect(await getActiveAppKey({ appId: key.appId, keyId: key.keyId })).toBeNull();
      expect(await listActiveMigrationKeys(sql)).toEqual([]);
      const actor: Parameters<typeof listAppKeys>[0]["actor"] = {
        id: "11111111-1111-4111-8111-111111111111",
        uid: "admin",
        provider: "local",
        roles: ["admin"],
      };
      const listing = await listAppKeys({ actor, appId: key.appId });
      expect(listing.ok).toBe(true);
      if (listing.ok) expect(listing.data.items[0]).toMatchObject({ status: "active", usable: false });
      const apps = await listAppsWithKeys({ actor });
      expect(apps.ok).toBe(true);
      if (apps.ok) expect(apps.data.items.find((app) => app.appId === key.appId)?.activeKeys).toBe(0);
      const result = await registerAppKey({
        actor: { id: "11111111-1111-4111-8111-111111111111", uid: "admin", provider: "local", roles: ["admin"] },
        appId: key.appId,
        publicKey: key.publicKey,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Development app keys");
      // A rejected restored fixture cannot consume either usable rotation slot.
      for (const pair of APP_KEY_FIXTURES.slice(0, 2)) {
        const created = await registerAppKey({ actor, appId: key.appId, publicKey: pair.publicKey });
        expect(created.ok).toBe(true);
      }
      const third = await registerAppKey({ actor, appId: key.appId, publicKey: APP_KEY_FIXTURES[2].publicKey });
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.error.message).toContain("at most two");
    } finally {
      Object.defineProperty(env, "NODE_ENV", previous);
    }
  });
  test("changing the identity of an already enrolled installation is refused", async () => {
    await sql`UPDATE auth.installation SET id = '11111111-1111-4111-8111-111111111111'::uuid`;
    await expect(enroll()).rejects.toThrow("already has app keys");
    expect((await sql<{ id: string }[]>`SELECT id FROM auth.installation`)[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
  });
});
