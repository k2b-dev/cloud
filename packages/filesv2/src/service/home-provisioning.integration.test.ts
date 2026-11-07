import "../../test/integration-preload";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type ProcessSync, sql, startProcessSync } from "@k2b/cloud";
import { accountIdentities, secrets } from "@k2b/cloud/services";
import { createAccountIdentityService } from "@k2b/cloud/services/accounts/identities";
import { Filegate, FilegateError } from "@k2b/filegate";
import { databaseSuite, suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { assertPrivateDatabase, localFilegateToken } from "../../test/private-database";
import { ConfigurationSchema, HomeProvisioningResultSchema } from "../contracts";
import { bindings } from "../data/bases";
import { homeProvisioning, migrateHomeProvisioning } from "../data/home-provisioning";
import { withRootLock } from "../data/operations";
import { migrate } from "../migrate";
import { connectFilegate } from "./filegate-facade";
import { createHomeProvisioning } from "./home-provisioning";
import { createDirectoryLifecycle } from "./lifecycle";

const provisioningIdentities = createAccountIdentityService(sql, async ({ name }) => ({
  state: "present",
  eligible: true,
  identity: { id: null, name, uidNumber: name === "alice" ? 31001 : 100002, gidNumber: name === "alice" ? 32001 : 100007 },
}));
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
databaseSuite()("Files automatic home identity projection and durable progress", () => {
  const setting = async (key: string, value: unknown) => {
    const encrypted = await secrets.encrypt(value);
    await sql`INSERT INTO settings.entries(key,value) VALUES(${key},${encrypted})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  };
  const user = async (n: number, profile = "user", provider = "local") => {
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id(n)}::uuid,${`user${n}`},${provider},${profile})`;
  };
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE SCHEMA filesv2`.simple();
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY,uid TEXT,provider TEXT,profile TEXT,account_expires TIMESTAMPTZ)`.simple();
    await sql`CREATE TABLE auth.user_posix(user_id UUID PRIMARY KEY,managed_by TEXT,uid_number INTEGER,primary_gid_number INTEGER)`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY,value TEXT)`.simple();
    await migrateHomeProvisioning();
  });
  beforeEach(async () => {
    await sql`TRUNCATE auth.users,auth.user_posix,settings.entries,filesv2.home_provisioning,filesv2.home_reconciliation CASCADE`.simple();
    await setting(
      "linux.identity_config",
      JSON.stringify({
        enabled: true,
        rangeStart: 200000,
        rangeEnd: 200100,
        homeTemplate: "/home/{username}",
        loginShell: "/bin/bash",
      }),
    );
    await setting("freeipa.enable", true);
  });
  test("application provisioning reads only active identities and minimal POSIX fields", async () => {
    await user(1);
    await user(2, "guest");
    await user(3);
    await user(4, "user", "ipa");
    await sql`UPDATE auth.users SET account_expires=now()-interval '1 second' WHERE id=${id(3)}::uuid`;
    await sql`INSERT INTO auth.user_posix VALUES(${id(1)}::uuid,'local',200001,200007)`;
    expect(await accountIdentities.provisioningUsers({ provider: "local" })).toEqual({
      items: [{ id: id(1), provider: "local", username: "user1", posix: { uidNumber: 200001, primaryGidNumber: 200007 } }],
      nextCursor: null,
      availability: { localLinuxEnabled: true, freeipaEnabled: true },
    });
    expect((await accountIdentities.provisioningUsers({})).items).toEqual([
      { id: id(1), provider: "local", username: "user1", posix: { uidNumber: 200001, primaryGidNumber: 200007 } },
      { id: id(4), provider: "ipa", username: "user4", posix: null },
    ]);
    await setting("user.category.login.enabled", false);
    expect((await accountIdentities.provisioningUsers({ provider: "local", id: id(1) })).items).toEqual([]);
  });
  test("provider ownership and positive UID/GID are required for a complete projection", async () => {
    await user(1);
    await sql`INSERT INTO auth.user_posix VALUES(${id(1)}::uuid,'ipa',200001,200007)`;
    expect((await accountIdentities.provisioningUsers({ provider: "local" })).items[0]!.posix).toBeNull();
    await sql`UPDATE auth.user_posix SET managed_by='local',primary_gid_number=0`;
    expect((await accountIdentities.provisioningUsers({ provider: "local" })).items[0]!.posix).toBeNull();
    await sql`UPDATE auth.user_posix SET primary_gid_number=NULL`;
    expect((await accountIdentities.provisioningUsers({ provider: "local" })).items[0]!.posix).toBeNull();
  });
  test("both providers persist their area and FreeIPA pending users resume only under its own setting", async () => {
    await user(1);
    await user(2, "user", "ipa");
    await user(3, "user", "ipa");
    await sql`INSERT INTO auth.user_posix VALUES(${id(1)}::uuid,'local',200001,200007),(${id(2)}::uuid,'ipa',100002,100007)`;
    const area = { enabled: true, prefix: "", homes: "users", groups: "groups", archive: "archive" };
    const config = {
      ...ConfigurationSchema.parse({
        url: "http://filegate.test",
        cloud: { ...area, root: "cloud", autoCreate: true },
        freeipa: { ...area, root: "freeipa" },
      }),
      token: "test-token",
      tokenConfigured: true,
      unreadable: false,
    };
    const created: string[] = [];
    const service = createHomeProvisioning({
      identities: provisioningIdentities,
      store: homeProvisioning,
      readConfiguration: async () => config,
      lock: async (run) => run(),
      provision: async (_config, base) => {
        created.push(base.identity_id);
        return { id: id(100), state: "complete", path: base.path };
      },
    });
    await service.reconcile();
    expect(await homeProvisioning.get(id(1))).toMatchObject({ area: "cloud", state: "done" });
    expect(await homeProvisioning.get(id(2))).toMatchObject({ area: "freeipa", state: "auto_create_off" });
    expect(await homeProvisioning.get(id(3))).toMatchObject({ area: "freeipa", state: "posix_incomplete" });
    expect(created).toEqual([id(1)]);
    config.freeipa.autoCreate = true;
    await homeProvisioning.request();
    await service.reconcile();
    expect(await homeProvisioning.get(id(2))).toMatchObject({ area: "freeipa", state: "done" });
    expect(await homeProvisioning.get(id(3))).toMatchObject({ area: "freeipa", state: "posix_incomplete" });
    await service.reconcile();
    expect(created).toEqual([id(1), id(2)]);
  });
  test("done Cloud state is replaced when the user migrates to FreeIPA", async () => {
    const status = {
      userId: id(1),
      username: "alice",
      area: "cloud" as const,
      state: "done" as const,
      operationId: id(100),
      eventId: null,
      errorCode: null,
    };
    await homeProvisioning.set(status);
    expect(await homeProvisioning.set({ ...status, area: "freeipa", state: "posix_incomplete", operationId: null })).toMatchObject({
      area: "freeipa",
      state: "posix_incomplete",
      operationId: null,
    });
  });
  test("identity pages and status pages are bounded and cursors do not repeat users", async () => {
    await sql`INSERT INTO auth.users(id,uid,provider,profile)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'user'||n,'local','user' FROM generate_series(1,55) n`;
    const page = await accountIdentities.provisioningUsers({ provider: "local" });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe(id(50));
    expect((await accountIdentities.provisioningUsers({ provider: "local", after: page.nextCursor! })).items).toHaveLength(5);
    await sql`INSERT INTO filesv2.home_provisioning(user_id,username,area,state) SELECT id,uid,'cloud','auto_create_off' FROM auth.users`;
    const statuses = await homeProvisioning.page({ state: "auto_create_off" });
    expect(statuses.items).toHaveLength(50);
    expect(statuses.nextCursor).toBe(id(50));
    expect((await homeProvisioning.page({ after: statuses.nextCursor!, state: "auto_create_off" })).items).toHaveLength(5);
  });
  test("area and state filter the bounded page while counts include both areas and all states", async () => {
    const status = { username: "alice", operationId: null, eventId: null, errorCode: null };
    await homeProvisioning.set({ ...status, userId: id(1), area: "cloud", state: "auto_create_off" });
    await homeProvisioning.set({ ...status, userId: id(2), area: "freeipa", state: "auto_create_off" });
    await homeProvisioning.set({ ...status, userId: id(3), area: "freeipa", state: "posix_incomplete" });
    const result = HomeProvisioningResultSchema.parse(await homeProvisioning.page({ area: "freeipa", state: "auto_create_off" }));
    expect(result.items.map((item) => item.userId)).toEqual([id(2)]);
    expect(result.counts).toEqual({ cloud: { auto_create_off: 1 }, freeipa: { auto_create_off: 1, posix_incomplete: 1 } });
    expect(result.reconcile).toEqual({ lastRunAt: null, lastResult: null, running: false });
    expect((await homeProvisioning.page({ area: "freeipa", after: id(2) })).items.map((item) => item.userId)).toEqual([id(3)]);
  });
  test("overview pending pages exclude completed homes before applying their bound", async () => {
    await sql`INSERT INTO filesv2.home_provisioning(user_id,area,state)
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'freeipa',
        CASE WHEN n<=55 THEN 'done' ELSE 'auto_create_off' END FROM generate_series(1,110) n`;
    const first = await homeProvisioning.page({ area: "freeipa", pendingOnly: true });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.userId).toBe(id(56));
    expect(first.nextCursor).toBe(id(105));
    expect(first.counts.freeipa).toEqual({ done: 55, auto_create_off: 55 });
    expect((await homeProvisioning.page({ area: "freeipa", pendingOnly: true, after: first.nextCursor! })).items).toHaveLength(5);
  });
  test("reconciliation summary is persisted, clears running, and survives repeated migration", async () => {
    await homeProvisioning.cursor();
    await homeProvisioning.start();
    expect((await homeProvisioning.page({})).reconcile.running).toBe(true);
    const result = { processed: 4, done: 1, pending: 2, failed: 1 };
    await homeProvisioning.finish(result);
    await sql`UPDATE filesv2.home_reconciliation SET last_run_at='2026-01-01T00:00:00Z'::timestamptz WHERE singleton=true`;
    await migrateHomeProvisioning();
    expect((await homeProvisioning.page({})).reconcile).toEqual({
      lastRunAt: "2026-01-01T00:00:00.000Z",
      lastResult: result,
      running: false,
    });
    expect(
      (await sql<{ running_until: Date | null }[]>`SELECT running_until FROM filesv2.home_reconciliation`)[0]?.running_until,
    ).toBeNull();
  });
  test("running status expires after a crash and per-user renewal restores its two-window lease", async () => {
    await homeProvisioning.cursor();
    await homeProvisioning.start();
    expect((await homeProvisioning.page({})).reconcile.running).toBe(true);
    await sql`UPDATE filesv2.home_reconciliation SET running_until=now()-interval '1 second'`;
    expect((await homeProvisioning.page({})).reconcile.running).toBe(false);
    await homeProvisioning.renew();
    expect((await homeProvisioning.page({})).reconcile.running).toBe(true);
    await homeProvisioning.finish({ processed: 0, done: 0, pending: 0, failed: 0 });
    expect((await homeProvisioning.page({})).reconcile.running).toBe(false);
  });
  test("the soft deadline persists partial totals and the exact cursor for a later reconciliation", async () => {
    for (let n = 1; n <= 3; n++) await user(n);
    let elapsed = 0;
    let advanceClock = true;
    const area = { enabled: false, prefix: "", homes: "users", groups: "groups", archive: "archive" };
    const config = {
      ...ConfigurationSchema.parse({ url: "", cloud: { ...area, root: "cloud" }, freeipa: { ...area, root: "freeipa" } }),
      token: "",
      tokenConfigured: false,
      unreadable: false,
    };
    const service = createHomeProvisioning({
      identities: provisioningIdentities,
      store: homeProvisioning,
      lock: async (run) => run(),
      now: () => elapsed,
      readConfiguration: async () => {
        if (advanceClock) elapsed += 30_000;
        return config;
      },
      provision: async () => {
        throw new Error("unconfigured homes must remain pending");
      },
    });
    expect(await service.reconcile()).toEqual({ processed: 1, done: 0, pending: 1, failed: 0, nextCursor: id(1) });
    expect((await homeProvisioning.cursor()).after_id).toBe(id(1));
    expect((await homeProvisioning.page({})).reconcile).toMatchObject({
      running: false,
      lastResult: { processed: 1, done: 0, pending: 1, failed: 0 },
    });
    advanceClock = false;
    expect(await service.reconcile()).toEqual({ processed: 2, done: 0, pending: 2, failed: 0, nextCursor: null });
    expect((await homeProvisioning.cursor()).after_id).toBeNull();
    expect((await homeProvisioning.page({})).reconcile.lastResult).toEqual({ processed: 2, done: 0, pending: 2, failed: 0 });
  });
  test("done receipts survive stale pending updates and reconciliation resets preserve newer requests", async () => {
    const status = {
      userId: id(1),
      username: "user1",
      area: "freeipa" as const,
      state: "done" as const,
      operationId: id(100),
      eventId: id(200),
      errorCode: null,
    };
    expect(await homeProvisioning.set(status)).toMatchObject(status);
    expect(await homeProvisioning.set({ ...status, state: "auto_create_off", operationId: null, eventId: null })).toMatchObject(status);
    const cursor = await homeProvisioning.cursor();
    await homeProvisioning.advance(id(50), cursor.revision);
    expect((await homeProvisioning.cursor()).after_id).toBe(id(50));
    await homeProvisioning.request();
    await homeProvisioning.advance(id(51), cursor.revision);
    expect((await homeProvisioning.cursor()).after_id).toBeNull();
  });

  suiteFor(
    "database",
    "filegate",
    "nats",
  )("real Filegate automatic homes and durable lifecycle receipts", () => {
    let processSync: ProcessSync | undefined;
    let client: Filegate;
    let token: string;
    beforeAll(async () => {
      await assertPrivateDatabase();
      await sql`CREATE TABLE auth.access(id UUID PRIMARY KEY DEFAULT gen_random_uuid())`.simple();
      await migrate();
      await migrateAudit();
      processSync = await startProcessSync({ application: "filesv2" });
      token = await localFilegateToken();
      client = new Filegate({ baseUrl: testInfra.filegate!, token });
    }, 30_000);
    afterAll(async () => {
      await processSync?.stop();
    });

    for (const provider of ["local", "ipa"] as const) {
      for (const failStatus of [false, true]) {
        test(`${provider}: one real home mkdir survives replay${failStatus ? " after a rejected done-status commit" : ""}`, async () => {
          const area = provider === "ipa" ? "freeipa" : "cloud";
          const userId = id(provider === "ipa" ? (failStatus ? 1004 : 1003) : failStatus ? 1002 : 1001);
          const prefix = `filesv2-home-test-${crypto.randomUUID()}`;
          const home = `${prefix}/users/alice`;
          const uid = 31001;
          const gid = 32001;
          let ownsPrefix = false;
          let mkdirs = 0;
          const transport: typeof fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              if ((init?.method ?? "GET") === "POST" && url.pathname === `/v1/roots/${area}/directories`) {
                const body: unknown = JSON.parse(String(init?.body));
                if (body && typeof body === "object" && "path" in body && body.path === home) mkdirs++;
              }
              return fetch(input, init);
            },
            { preconnect: fetch.preconnect },
          );
          const areaConfig = { enabled: true, prefix, homes: "users", groups: "groups", archive: "archive", autoCreate: true };
          const config = {
            ...ConfigurationSchema.parse({
              url: testInfra.filegate!,
              cloud: { ...areaConfig, root: "cloud" },
              freeipa: { ...areaConfig, root: "freeipa" },
            }),
            token,
            tokenConfigured: true,
            unreadable: false,
          };
          const makeService = () => {
            const lifecycle = createDirectoryLifecycle({
              identities: provisioningIdentities,
              bindings,
              readConfiguration: async () => config,
              connect: (value) => connectFilegate(value, transport),
            });
            return createHomeProvisioning({
              identities: provisioningIdentities,
              store: homeProvisioning,
              readConfiguration: async () => config,
              provision: lifecycle.provisionCandidate,
              lock: (run) => withRootLock("filesv2:home-reconciliation", run),
            });
          };
          try {
            await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,'alice',${provider},'user')`;
            await sql`INSERT INTO auth.user_posix VALUES(${userId}::uuid,${provider},${uid},${gid})`;
            await client.root(area).mkdir(prefix, { ownership: { dirMode: "0755" } });
            ownsPrefix = true;
            const daemon = await client.root(area).stat(prefix);
            if (provider === "ipa") {
              await sql`UPDATE auth.user_posix SET uid_number=${uid + 1} WHERE user_id=${userId}::uuid`;
              expect(await makeService().ensure(userId)).toMatchObject({ area, state: "posix_incomplete" });
              expect(mkdirs).toBe(0);
              await expect(client.root(area).stat(home)).rejects.toMatchObject({ status: 404 });
              await sql`UPDATE auth.user_posix SET uid_number=${uid} WHERE user_id=${userId}::uuid`;
            }
            if (failStatus) {
              await sql`CREATE FUNCTION filesv2.reject_home_done() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                  IF NEW.state='done' THEN RAISE EXCEPTION 'injected home status commit failure'; END IF;
                  RETURN NEW;
                END $$`.simple();
              await sql`CREATE TRIGGER reject_home_done BEFORE INSERT OR UPDATE ON filesv2.home_provisioning
                FOR EACH ROW EXECUTE FUNCTION filesv2.reject_home_done()`.simple();
              await expect(makeService().ensure(userId, { eventId: id(200) })).rejects.toThrow("injected home status commit failure");
              expect(await homeProvisioning.get(userId)).toMatchObject({ area, state: "failed" });
              await sql`DROP TRIGGER reject_home_done ON filesv2.home_provisioning`.simple();
              await sql`DROP FUNCTION filesv2.reject_home_done()`.simple();
            } else {
              expect(await makeService().ensure(userId, { eventId: id(200) })).toMatchObject({ area, state: "done" });
            }
            const rows = await sql<{ id: string; state: string; actor_id: string | null; actor_name: string }[]>`
              SELECT id,state,actor_id,actor_name FROM filesv2.operations WHERE root=${area} AND source=${home} AND action='create'`;
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ state: "complete", actor_id: null, actor_name: "automatic-policy" });
            const before = await client.root(area).stat(home);
            expect(before).toMatchObject({
              directory: true,
              mode: "0700",
              uid: provider === "ipa" ? uid : daemon.uid,
              gid: provider === "ipa" ? gid : daemon.gid,
            });
            const acl = [
              { tag: "owner", permissions: "rwx" },
              { tag: "owningGroup", permissions: "---" },
              { tag: "other", permissions: "---" },
            ];
            for (const scope of ["access", "default"] as const)
              expect((await client.root(area).getACL(home, scope)).entries).toEqual(expect.arrayContaining(acl));
            const replay = await makeService().ensure(userId, { eventId: id(200) });
            expect(replay).toMatchObject({ area, state: "done", operationId: rows[0]!.id, eventId: id(200) });
            await makeService().ensure(userId, { eventId: id(201) });
            expect(mkdirs).toBe(1);
            expect(await client.root(area).stat(home)).toEqual(before);
            expect(await bindings.path(area, home)).toMatchObject({ identity_id: userId, lifecycle: "active" });
            const receipts = await sql<{ id: string; state: string }[]>`
              SELECT id,state FROM filesv2.operations WHERE root=${area} AND source=${home} AND action='create'`;
            expect(receipts).toEqual([{ id: rows[0]!.id, state: "complete" }]);
          } finally {
            try {
              await sql`DROP TRIGGER IF EXISTS reject_home_done ON filesv2.home_provisioning`.simple();
              await sql`DROP FUNCTION IF EXISTS filesv2.reject_home_done()`.simple();
            } finally {
              if (ownsPrefix) {
                try {
                  await client.root(area).remove(prefix, true);
                } catch (error) {
                  if (!(error instanceof FilegateError && error.status === 404)) throw error;
                }
              }
            }
          }
        }, 60_000);
      }
    }
  });
});
