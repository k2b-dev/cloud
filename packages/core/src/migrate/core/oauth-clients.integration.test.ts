import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { connections } from "@k2b/cloud";
import { oauthClients } from "@k2b/cloud/services";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./oauth-clients";

databaseSuite()("OAuth client registry migration and ownership", () => {
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  let db: SQL;
  let previousAppId: string;
  beforeAll(async () => {
    disposable = await useFreshDatabase("oauth_client_registry");
    db = new SQL(disposable.url);
    previousAppId = connections().appId;
  });
  beforeEach(async () => {
    connections().appId = "issuer-one";
    await db`DROP SCHEMA IF EXISTS oauth CASCADE`.simple();
    await db`DROP SCHEMA IF EXISTS auth CASCADE`.simple();
    await db`CREATE SCHEMA auth`.simple();
    await db`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY)`.simple();
    await db`CREATE TABLE auth.app_logins(kind TEXT,client_id TEXT,device_authorization_id UUID,
      oauth_issuer_app_id TEXT,oauth_client_name TEXT,oauth_grant_expires_at TIMESTAMPTZ)`.simple();
  });
  afterAll(async () => {
    if (previousAppId) connections().appId = previousAppId;
    await db?.close();
    await disposable?.drop();
  });
  test("concurrent fresh installs need no built-in OAuth schema", async () => {
    await Promise.all([migrate(db), migrate(db)]);
    expect(await db`SELECT * FROM auth.oauth_clients`).toHaveLength(0);
    expect((await db`SELECT to_regclass('oauth.clients') AS issuer_table`)[0].issuer_table).toBeNull();
  });
  test("backfills once, including terminal display and deadline, and never resurrects a removed client", async () => {
    const account = crypto.randomUUID(),
      grant = crypto.randomUUID();
    await db`INSERT INTO auth.service_accounts VALUES (${account}::uuid)`;
    await db`CREATE SCHEMA oauth`.simple();
    await db`CREATE TABLE oauth.clients(client_id TEXT,name TEXT,service_account_id UUID)`.simple();
    await db`CREATE TABLE oauth.device_authorizations(id UUID,expires_at TIMESTAMPTZ)`.simple();
    await db`INSERT INTO oauth.clients VALUES ('old-client','Old client',${account}::uuid)`;
    await db`INSERT INTO oauth.device_authorizations VALUES (${grant}::uuid,'2030-01-02T03:09:05.123456Z')`;
    await db`INSERT INTO auth.app_logins(kind,client_id,device_authorization_id) VALUES ('terminal','old-client',${grant}::uuid)`;
    await Promise.all([migrate(db), migrate(db)]);
    const clients = await db`SELECT * FROM auth.oauth_clients`;
    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual({
      client_id: "old-client",
      issuer_app_id: "oauth",
      service_account_id: account,
      status: "active",
      name: "Old client",
    });
    expect((await db`SELECT oauth_issuer_app_id,oauth_client_name,oauth_grant_expires_at FROM auth.app_logins`)[0]).toEqual({
      oauth_issuer_app_id: "oauth",
      oauth_client_name: "Old client",
      oauth_grant_expires_at: new Date("2030-01-02T03:09:05.123Z"),
    });
    connections().appId = "oauth";
    await db.begin((tx) => oauthClients.remove(tx, "old-client"));
    await migrate(db);
    expect((await db`SELECT status FROM auth.oauth_clients`)[0].status).toBe("deleted");
    await db`INSERT INTO oauth.clients VALUES ('later-client','Later client',NULL)`;
    await migrate(db);
    expect(await db`SELECT client_id FROM auth.oauth_clients WHERE client_id='later-client'`).toHaveLength(0);
  });
  test("captures the running issuer, refuses transfers and shares the issuer's transaction", async () => {
    await migrate(db);
    const input = { clientId: "independent-client", name: "Independent client", serviceAccountId: null, status: "active" as const };
    await db.begin((tx) => oauthClients.upsert(tx, input));
    connections().appId = "issuer-two";
    await expect(db.begin((tx) => oauthClients.upsert(tx, { ...input, name: "Another owner" }))).rejects.toThrow("another issuer");
    await db.begin((tx) => oauthClients.remove(tx, input.clientId));
    expect((await db`SELECT issuer_app_id,name FROM auth.oauth_clients`)[0]).toEqual({ issuer_app_id: "issuer-one", name: input.name });
    connections().appId = "issuer-one";
    const rollback = new Error("Issuer transaction rolled back");
    await expect(
      db.begin(async (tx) => {
        await oauthClients.upsert(tx, { ...input, name: "Changed", status: "disabled" });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await db`SELECT name,status FROM auth.oauth_clients`)[0]).toEqual({ name: input.name, status: "active" });
    await db.begin((tx) => oauthClients.remove(tx, input.clientId));
    expect((await db`SELECT status,issuer_app_id FROM auth.oauth_clients`)[0]).toEqual({ status: "deleted", issuer_app_id: "issuer-one" });
    await expect(db.begin((tx) => oauthClients.upsert(tx, input))).rejects.toThrow("has been deleted");
    connections().appId = "issuer-two";
    await expect(db.begin((tx) => oauthClients.upsert(tx, input))).rejects.toThrow("has been deleted");
    await db.begin((tx) => oauthClients.remove(tx, input.clientId));
    expect((await db`SELECT status,issuer_app_id FROM auth.oauth_clients`)[0]).toEqual({ status: "deleted", issuer_app_id: "issuer-one" });
  });
  test("deleting a bound service account clears the registry binding", async () => {
    await migrate(db);
    const id = crypto.randomUUID();
    await db`INSERT INTO auth.service_accounts VALUES (${id}::uuid)`;
    await db.begin((tx) => oauthClients.upsert(tx, { clientId: "machine", name: "Machine", serviceAccountId: id, status: "active" }));
    await db`DELETE FROM auth.service_accounts WHERE id=${id}::uuid`;
    expect((await db`SELECT service_account_id FROM auth.oauth_clients`)[0].service_account_id).toBeNull();
  });
});
