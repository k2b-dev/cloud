import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { accountRequestsEnabled } from "@k2b/cloud/services/accounts/request-policy";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./settings";

const suite = databaseSuite();
suite("account request opt-in migration", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    disposable = await useFreshDatabase("settings_migration");
    db = new SQL(disposable.url);
  });
  beforeEach(async () => {
    await db`DROP SCHEMA IF EXISTS settings CASCADE`.simple();
  });
  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });
  const oldInstallation = async () => {
    await db`CREATE SCHEMA settings`.simple();
    await db`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`.simple();
  };
  test("creates the schema when a waiting migrator cached it as missing", async () => {
    const stale = new SQL({ url: disposable.url, max: 1 });
    const holder = new SQL({ url: disposable.url, max: 1 });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    const waitForLock = async (pid: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await db<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted
        ) AS waiting`;
        if (row?.waiting) return;
        await Bun.sleep(10);
      }
      throw new Error(`Migrator ${pid} did not wait on the advisory lock before the deadline`);
    };
    try {
      // Warm statements and catalog caches first, then cache the missing schema on this backend.
      await migrate(stale);
      await stale`DROP SCHEMA IF EXISTS settings CASCADE`.simple();
      await stale`DROP SCHEMA IF EXISTS settings CASCADE`.simple();
      const [staleBackend] = await stale<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!staleBackend) throw new Error("Missing migrator backend PID");
      const holding = holder.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.settings.migrations', 0))`;
        await tx`CREATE SCHEMA settings`.simple();
        await tx`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
        locked.resolve();
        await release.promise;
      });
      pending.push(holding);
      void holding.catch(() => {});
      await Promise.race([locked.promise, holding]);
      const migratingStale = migrate(stale);
      pending.push(migratingStale);
      void migratingStale.catch(() => {});
      await waitForLock(staleBackend.pid);
      release.resolve();
      await Promise.all([holding, migratingStale]);
      expect(await db<{ name: string }[]>`SELECT name FROM settings.migrations`).toEqual([{ name: "account-request-opt-in-v1" }]);
      // The waiting migrator must also see the holder's entries table as an existing installation.
      expect(await accountRequestsEnabled(db)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await Promise.all([stale.close(), holder.close()]);
    }
  }, 15_000);
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
