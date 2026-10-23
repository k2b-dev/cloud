import { beforeAll, expect, spyOn, test } from "bun:test";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { SQL, sql } from "bun";
import { clickhouseAdminQuery as admin, clickhouseTestPrefix as prefix } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { READ_VIEWS } from "../store/base-schema";
import { createBaseStore, loadStoreRow } from "../store/base-store";
import {
  cleanupFixtureBase,
  fixtureBase,
  fixtureClock,
  fixtureConnection,
  fixtureStore,
  installFixtureStore,
} from "../store/base-store.test-fixture";
import { clickhouseQuery } from "../store/client";
import { MaintenanceBusy } from "../store/maintenance-query";
import { quoteIdentifier as q } from "../store/validation";
import { requireBaseActive, requireBaseWritable } from "./access-control";
import { createBaseLifecycle } from "./base-lifecycle";
import { ingestBatch } from "./ingest-writer";
import { createSource, createSourceApiKey, removeSourceApiKey } from "./source-management";

const suite = suiteFor("database", "clickhouse");
const runUntilDone = async (run: () => Promise<{ done: boolean }>) => {
  for (let n = 0; n < 100; n++) if ((await run()).done) return;
  throw new Error("LIFECYCLE_DID_NOT_FINISH");
};
const sourceKeyFixture = async () => {
  const base = await fixtureBase();
  await createBaseLifecycle(fixtureStore())(base.id);
  const identity = adminFixtureIdentity(crypto.randomUUID());
  if (identity.actor.kind !== "user") throw new Error("Expected user fixture");
  const user = identity.actor.user;
  const sourceId = crypto.randomUUID(),
    shortId = newShortId();
  await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${user.id}::uuid,${user.id},'local','user')`;
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user.id}::uuid,'admin') RETURNING id`;
  await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${access!.id}::uuid)`;
  await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${shortId},${base.id}::uuid,'http_ingest','Key fixture')`;
  return {
    baseId: base.id,
    sourceId,
    user,
    cleanup: async () => {
      await sql`DELETE FROM auth.service_accounts WHERE app_id='pulse' AND resource_type='pulse_source' AND resource_id=${shortId}`;
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    },
  };
};
suite("Pulse per-base store lifecycle", () => {
  beforeAll(installFixtureStore, 30_000);
  test("maintenance contention preserves lifecycle attempts and asks for delayed resubmission", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    const run = createBaseLifecycle({
      ...store,
      prepare: async () => async () => {
        throw new MaintenanceBusy();
      },
    });
    try {
      for (let attempt = 0; attempt < 6; attempt++) expect(await run(base.id)).toEqual({ done: false, retryAfterMs: 5000 });
      const row = await loadStoreRow(base.id);
      expect(row?.state).toBe("provisioning");
      const [attempt] = await sql<{ attempts: number }[]>`SELECT attempts FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
      expect(attempt?.attempts).toBe(0);
    } finally {
      await cleanupFixtureBase(base);
    }
  });
  test("source key creation and removal exceed a two-connection pool without nested reservations", async () => {
    const f = await sourceKeyFixture();
    const database = new SQL({ max: 2 });
    const begin = database.begin.bind(database);
    const boundary = spyOn(sql, "begin").mockImplementation((run) => {
      if (typeof run === "string") throw new Error("Unexpected transaction options in source key fixture");
      return begin(run);
    });
    // Make pool-backed service calls contend for the same bounded pool as Pulse transactions.
    const getOrCreate = serviceAccounts.getOrCreateResourceBound;
    const accountLookup = spyOn(serviceAccounts, "getOrCreateResourceBound").mockImplementation(async (params) => {
      await database`SELECT 1`;
      return getOrCreate(params);
    });
    const list = serviceAccountCredentials.listOverview;
    const credentialLookup = spyOn(serviceAccountCredentials, "listOverview").mockImplementation(async (params) => {
      await database`SELECT 1`;
      return list(params);
    });
    const pending: Promise<unknown>[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Source keys starved the SQL pool")), 10000);
    });
    try {
      const creates = Array.from({ length: 6 }, (_, i) =>
        createSourceApiKey({ baseId: f.baseId, sourceId: f.sourceId, user: f.user, name: `Key ${i}`, permission: "write" }),
      );
      pending.push(...creates);
      const created = await Promise.race([Promise.all(creates), deadline]);
      const removes = created.map((result) => {
        if (!result.ok) throw new Error(result.error.message);
        return removeSourceApiKey({ baseId: f.baseId, sourceId: f.sourceId, user: f.user, credentialId: result.data.credential.id });
      });
      pending.push(...removes);
      expect((await Promise.race([Promise.all(removes), deadline])).every((result) => result.ok)).toBe(true);
    } finally {
      clearTimeout(timeout);
      await database.close({ timeout: 1 });
      await Promise.allSettled(pending);
      boundary.mockRestore();
      accountLookup.mockRestore();
      credentialLookup.mockRestore();
      await f.cleanup();
    }
  }, 30000);
  test.each(["clearing", "deleting", "source removed"])(
    "a key created during %s is revoked by the locked post-check",
    async (state) => {
      const f = await sourceKeyFixture();
      const create = serviceAccountCredentials.createResourceApiToken;
      let credentialId: string | undefined;
      const boundary = spyOn(serviceAccountCredentials, "createResourceApiToken").mockImplementation(async (params) => {
        const result = await create(params);
        if (result.ok) {
          credentialId = result.data.credential.id;
          if (state === "source removed") await sql`UPDATE pulse.sources SET deleted=true WHERE id=${f.sourceId}::uuid`;
          else await sql`UPDATE pulse.base_stores SET state=${state} WHERE base_id=${f.baseId}::uuid`;
        }
        return result;
      });
      try {
        expect(
          await createSourceApiKey({ baseId: f.baseId, sourceId: f.sourceId, user: f.user, name: "Racing key", permission: "write" }),
        ).toMatchObject({
          ok: false,
          error: { status: state === "source removed" ? 404 : 409 },
        });
        expect(credentialId).toBeDefined();
        expect(await sql<{ status: string }[]>`SELECT status FROM auth.service_account_credentials WHERE id=${credentialId}::uuid`).toEqual(
          [{ status: "revoked" }],
        );
      } finally {
        boundary.mockRestore();
        await f.cleanup();
      }
    },
    30000,
  );
  test("provisions tables, six SELECT grants and the selected read profile", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      expect((await requireBaseActive(base.id)).ok).toBe(false);
      await createBaseLifecycle(store)(base.id);
      expect((await loadStoreRow(base.id))?.state).toBe("active");
      const tables = await admin("SELECT name FROM system.tables WHERE database={database:String}", {
        params: { database: base.database },
      });
      expect(tables.map((t) => t.name).sort()).toEqual(
        [
          "_samples",
          "_rollups",
          "_series",
          "_events",
          "_states_current",
          "_state_changes",
          "_sources",
          "_checkpoints",
          ...READ_VIEWS,
        ].sort(),
      );
      const grants = await admin(`SHOW GRANTS FOR ${q(base.readUser)}`);
      expect(grants.map((r) => Object.values(r)[0]).sort()).toEqual(
        READ_VIEWS.map((view) => `GRANT SELECT ON ${base.database}.${view} TO ${base.readUser}`).sort(),
      );
      const credentials = await store.readUserCredentials(base.id);
      const [setting] = await clickhouseQuery({
        ...fixtureConnection(),
        ...credentials,
        query: "SELECT getSetting('max_memory_usage') AS memory",
        timeoutMs: 5000,
      });
      expect(Number(setting?.memory)).toBe(2_000_000_000);
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 60_000);
  test("ingest and source creation refuse every non-active state", async () => {
    const base = await fixtureBase();
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`writes-${base.id}`},'local','user','Write fixture') RETURNING id`;
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
    try {
      for (const state of ["provisioning", "clearing", "deleting", "failed"]) {
        await sql`UPDATE pulse.base_stores SET state=${state} WHERE base_id=${base.id}::uuid`;
        expect((await ingestBatch({ baseId: base.id, sourceId: crypto.randomUUID(), batch: { events: [{ kind: "refused" }] } })).ok).toBe(
          false,
        );
        expect((await createSource({ baseId: base.id, user: { id: user!.id }, name: "Refused", kind: "http_ingest" })).ok).toBe(false);
      }
    } finally {
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
  const operations = [
    {
      operation: "provision",
      state: "provisioning",
      steps: [
        "password",
        "database",
        "schema",
        "ttl",
        "reader",
        "grants",
        "checkpoint_pending",
        "checkpoint_insert",
        "checkpoint_accept",
        "active",
      ],
    },
    {
      operation: "clear",
      state: "clearing",
      steps: [
        "postgres:state_variants",
        "postgres:state_keys",
        "postgres:event_kinds",
        "postgres:metric_hours",
        "postgres:source_scrapes",
        "postgres:ingest_idempotency",
        "postgres:metric_series",
        "postgres:metric_defs",
        "password",
        "database",
        "schema",
        "ttl",
        "reader",
        "grants",
        "truncate",
        "checkpoint_pending",
        "checkpoint_insert",
        "checkpoint_accept",
        "active",
      ],
    },
    {
      operation: "delete",
      state: "deleting",
      steps: [
        "drop_reader",
        "postgres:state_variants",
        "postgres:state_keys",
        "postgres:event_kinds",
        "postgres:metric_hours",
        "postgres:source_scrapes",
        "postgres:ingest_idempotency",
        "postgres:metric_series",
        "postgres:metric_defs",
        "postgres:sources",
        "drop_database",
        "access",
        "base",
      ],
    },
  ] as const;
  for (const operation of operations)
    for (const step of operation.steps)
      test(`resumes ${operation.operation} after ${step}`, async () => {
        const base = await fixtureBase(),
          store = fixtureStore();
        let injected = false;
        try {
          if (operation.operation !== "provision") await createBaseLifecycle(store)(base.id);
          await sql`UPDATE pulse.base_stores SET state=${operation.state},operation=${operation.operation} WHERE base_id=${base.id}::uuid`;
          const broken = createBaseStore({
            prefix,
            clock: fixtureClock,
            connection: async () => fixtureConnection(),
            beforeStep: async (op, current) => {
              if (op === operation.operation && current === step && !injected) {
                injected = true;
                throw new Error("FAULT_INJECTION");
              }
            },
          });
          await expect(createBaseLifecycle(broken)(base.id)).rejects.toThrow("STORE_UNREACHABLE");
          expect(injected).toBe(true);
          await runUntilDone(() => createBaseLifecycle(store)(base.id));
          const row = await loadStoreRow(base.id);
          if (operation.operation === "delete") {
            expect(row).toBeNull();
            expect(
              (await admin("SELECT name FROM system.databases WHERE name={db:String}", { params: { db: base.database } })).length,
            ).toBe(0);
          } else {
            expect(row?.state).toBe("active");
            expect((await requireBaseWritable(base.id)).ok).toBe(true);
          }
        } finally {
          await cleanupFixtureBase(base);
        }
      }, 60_000);
  test("reconcile clears its flag without losing Postgres timestamp precision", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      await sql`UPDATE pulse.base_stores SET reconcile_needed=true,updated_at='2026-10-17T12:00:00.123456Z'::timestamptz WHERE base_id=${base.id}::uuid`;
      await createBaseLifecycle(store)(base.id);
      const [row] = await sql`SELECT reconcile_needed FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
      expect(row?.reconcile_needed).toBe(false);
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("a newer operation with the same state supersedes a stale run before its next write", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      await sql`UPDATE pulse.base_stores SET state='clearing',operation='clear' WHERE base_id=${base.id}::uuid`;
      let superseded = false;
      const observed = createBaseStore({
        prefix,
        clock: fixtureClock,
        connection: async () => fixtureConnection(),
        beforeStep: async (_operation, step) => {
          if (step === "truncate" && !superseded) {
            superseded = true;
            await sql`UPDATE pulse.base_stores SET updated_at=updated_at+interval '1 second' WHERE base_id=${base.id}::uuid`;
          }
        },
      });
      expect(await createBaseLifecycle(observed)(base.id)).toEqual({ done: false });
      expect((await loadStoreRow(base.id))?.state).toBe("clearing");
      await createBaseLifecycle(store)(base.id);
      expect((await loadStoreRow(base.id))?.state).toBe("active");
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("five failed attempts keep the operation, then retry can finish", async () => {
    const base = await fixtureBase();
    try {
      const broken = createBaseStore({ prefix, connection: async () => null });
      for (let i = 0; i < 5; i++) await expect(createBaseLifecycle(broken)(base.id)).rejects.toThrow("STORE_NOT_CONFIGURED");
      expect(await loadStoreRow(base.id)).toMatchObject({ state: "failed", operation: "provision" });
      // The retry service performs this state transition after its permission check.
      await sql`UPDATE pulse.base_stores SET state='provisioning',attempts=0 WHERE base_id=${base.id}::uuid`;
      await createBaseLifecycle(fixtureStore())(base.id);
      expect((await loadStoreRow(base.id))?.state).toBe("active");
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("clear keeps sources and tokens; delete revokes its reader before dropping the database", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      source = crypto.randomUUID();
    try {
      await createBaseLifecycle(store)(base.id);
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${source}::uuid,${newShortId()},${base.id}::uuid,'http_ingest','Preserved source')`;
      await sql`INSERT INTO auth.service_accounts(name,kind,app_id,resource_type,resource_id) VALUES('Source token fixture','resource_bound','pulse','pulse_source',${(await sql`SELECT short_id FROM pulse.sources WHERE id=${source}::uuid`)[0]!.short_id})`;
      await store.query(`INSERT INTO ${q(base.database)}._events(id,ts,kind,version) VALUES(generateUUIDv4(),now64(3),'marker',1)`);
      // A base over its storage threshold: after the clear, ingest must not refuse it until the next usage scan.
      await sql`UPDATE pulse.base_stores SET state='clearing',operation='clear',usage_bytes=storage_bytes,usage_rows=1,usage_measured_at=now(),storage_exceeded_at=now() WHERE base_id=${base.id}::uuid`;
      await runUntilDone(() => createBaseLifecycle(store)(base.id));
      const [count] = await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`);
      expect(Number(count?.n)).toBe(0);
      expect(
        (
          await sql`SELECT usage_bytes,usage_rows,usage_measured_at,storage_exceeded_at FROM pulse.base_stores WHERE base_id=${base.id}::uuid`
        )[0],
      ).toEqual({ usage_bytes: null, usage_rows: null, usage_measured_at: null, storage_exceeded_at: null });
      expect((await sql`SELECT id FROM pulse.sources WHERE id=${source}::uuid`).length).toBe(1);
      const [tokens] =
        await sql`SELECT count(*)::int AS n FROM auth.service_accounts WHERE kind='resource_bound' AND resource_id=(SELECT short_id FROM pulse.sources WHERE id=${source}::uuid)`;
      expect(tokens?.n).toBe(1);
      const order: string[] = [];
      const observed = createBaseStore({
        prefix,
        connection: async () => fixtureConnection(),
        beforeStep: async (_op, step) => {
          order.push(step);
          if (step === "drop_database")
            expect(
              (await admin("SELECT name FROM system.users WHERE name={user:String}", { params: { user: base.readUser } })).length,
            ).toBe(0);
        },
      });
      await sql`UPDATE pulse.base_stores SET state='deleting',operation='delete' WHERE base_id=${base.id}::uuid`;
      await runUntilDone(() => createBaseLifecycle(observed)(base.id));
      expect(order.indexOf("drop_reader")).toBeLessThan(order.indexOf("drop_database"));
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE name='Source token fixture'`;
      await cleanupFixtureBase(base);
    }
  }, 60_000);
});
