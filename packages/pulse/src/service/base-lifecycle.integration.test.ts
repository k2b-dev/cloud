import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery as admin, clickhouseTestPrefix as prefix } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
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
import { quoteIdentifier as q } from "../store/validation";
import { requireBaseActive, requireBaseWritable } from "./access-control";
import { createBaseLifecycle } from "./base-lifecycle";
import { createDashboard } from "./dashboard-management";
import { ingestBatch } from "./ingest-writer";
import { createSource } from "./source-management";

const suite = suiteFor("database", "clickhouse");
const runUntilDone = async (run: () => Promise<{ done: boolean }>) => {
  for (let n = 0; n < 100; n++) if ((await run()).done) return;
  throw new Error("LIFECYCLE_DID_NOT_FINISH");
};
suite("Pulse per-base store lifecycle", () => {
  beforeAll(installFixtureStore, 30_000);
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
  test("ingest, source creation and dashboard saves refuse every non-active state", async () => {
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
        expect((await createDashboard({ baseId: base.id, user: { id: user!.id }, name: "Refused" })).ok).toBe(false);
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
        "postgres:metric_samples",
        "postgres:metric_rollups_hourly",
        "postgres:metric_hours",
        "postgres:state_changes",
        "postgres:events",
        "postgres:states_current",
        "postgres:metric_series_dimensions",
        "postgres:source_scrapes",
        "postgres:ingest_idempotency",
        "postgres:metric_series",
        "postgres:metric_defs",
        "postgres:signal_fields",
        "postgres:observed_resources",
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
        "postgres:metric_samples",
        "postgres:metric_rollups_hourly",
        "postgres:metric_hours",
        "postgres:state_changes",
        "postgres:events",
        "postgres:states_current",
        "postgres:metric_series_dimensions",
        "postgres:source_scrapes",
        "postgres:ingest_idempotency",
        "postgres:metric_series",
        "postgres:metric_defs",
        "postgres:signal_fields",
        "postgres:observed_resources",
        "postgres:saved_queries",
        "postgres:dashboards",
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
      await sql`UPDATE pulse.base_stores SET state='clearing',operation='clear' WHERE base_id=${base.id}::uuid`;
      await runUntilDone(() => createBaseLifecycle(store)(base.id));
      const [count] = await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`);
      expect(Number(count?.n)).toBe(0);
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
