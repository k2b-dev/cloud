import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { accountRequestsEnabled } from "@k2b/cloud/services/accounts/request-policy";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { SQL } from "bun";
import { migrate } from "./settings";

// Explicit opt-in and a fixed, dedicated test database. Never use the app DB.
const requested = process.env.CLOUD_ADMIN_SLICE_TEST === "1";
const suite = requested ? describe : describe.skip;
suite("account request opt-in migration", () => {
  let db: SQL;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.port !== "55459" || url.pathname !== "/cloud_admin_slice_test") {
      throw new Error("Dedicated account-administration test database required");
    }
    db = new SQL(url.toString());
  });
  beforeEach(async () => {
    await db`DROP SCHEMA IF EXISTS settings CASCADE`.simple();
  });
  afterAll(async () => {
    await db?.close();
  });
  const oldInstallation = async () => {
    await db`CREATE SCHEMA settings`.simple();
    await db`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`.simple();
  };
  test("fresh installs opt in, including after concurrent restarts", async () => {
    await Promise.all([migrate(db), migrate(db)]);
    expect(await accountRequestsEnabled(db)).toBe(false);
    expect((await db`SELECT name FROM settings.migrations`).length).toBe(1);
  });
  test("upgrades preserve enabled requests in the encrypted setting format", async () => {
    await oldInstallation();
    await migrate(db);
    expect(await accountRequestsEnabled(db)).toBe(true);
    expect((await db`SELECT value FROM settings.entries`)[0].value).not.toBe("true");
    await migrate(db);
    expect(await accountRequestsEnabled(db)).toBe(true);
  });
  test("explicit false survives upgrade; resetting it cannot rerun the backfill", async () => {
    await oldInstallation();
    await db`INSERT INTO settings.entries(key, value) VALUES ('user.account_requests.enabled', ${await encryptValue(false)})`;
    await migrate(db);
    expect(await accountRequestsEnabled(db)).toBe(false);
    await db`DELETE FROM settings.entries WHERE key = 'user.account_requests.enabled'`;
    await migrate(db);
    expect(await accountRequestsEnabled(db)).toBe(false);
  });
  test("the policy reads durable changes and rejects malformed values", async () => {
    await migrate(db);
    await db`INSERT INTO settings.entries(key, value) VALUES ('user.account_requests.enabled', ${await encryptValue(true)})`;
    expect(await accountRequestsEnabled(db)).toBe(true);
    await db`UPDATE settings.entries SET value = ${await encryptValue(false)} WHERE key = 'user.account_requests.enabled'`;
    expect(await accountRequestsEnabled(db)).toBe(false);
    await db`UPDATE settings.entries SET value = ${await encryptValue("false")} WHERE key = 'user.account_requests.enabled'`;
    await expect(accountRequestsEnabled(db)).rejects.toThrow("Invalid account request policy");
  });
  test("disabled requests reject creation but preserve existing request processing", async () => {
    await migrate(db);
    await (await import("./auth")).migrate();
    await (await import("./audit")).migrate();
    const { accountsAppService } = await import("@k2b/cloud/services");
    const id = crypto.randomUUID();
    await db`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${id}, ${id}, 'local', 'user')`;
    const [pending] = await db`INSERT INTO auth.account_requests(user_id, status) VALUES (${id}, 'pending') RETURNING id`;
    const actor = { userId: id, uid: id, provider: "local", roles: ["user"] } as const;
    const create = await accountsAppService.accountRequest.create({
      user: { id, uid: id, provider: "local", roles: ["user"], mail: null },
      data: { acceptedAgb: true },
    });
    expect(create).toMatchObject({ ok: false, error: { status: 403, message: "Account requests are disabled" } });
    expect(
      (await accountsAppService.accountRequest.list({ access: { userId: id, isAdmin: false } })).items.map((item) => item.id),
    ).toContain(pending.id);
    expect((await accountsAppService.accountRequest.get({ id: pending.id, access: { userId: id, isAdmin: true } })).ok).toBe(true);
    expect((await accountsAppService.accountRequest.withdraw({ id: pending.id, actor: { ...actor, roles: [...actor.roles] } })).ok).toBe(
      true,
    );
    expect(await accountsAppService.accountRequest.getPendingForUser({ userId: id })).toBeNull();
  });
});
