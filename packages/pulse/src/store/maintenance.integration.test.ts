import { beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery as admin, clickhouseTestAdmin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { requireBaseWritable } from "../service/access-control";
import { adminBaseAction, deleteOrphan, listAdminBases, listOrphans, retryBase } from "../service/base-admin";
import * as lifecycle from "../service/base-lifecycle";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { runCheckpointScan, runUsageScan } from "../service/base-maintenance-runtime";
import { clearBaseData, listBases, listDeletingBases } from "../service/base-management";
import { ingestBatch } from "../service/ingest-writer";
import { adminFixtureIdentity } from "./admin-identity.test-fixture";
import { READ_VIEWS } from "./base-schema";
import { loadStoreRow } from "./base-store";
import { cleanupFixtureBase, fixtureBase, fixtureClock, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { clickhouseQuery } from "./client";
import { acceptCheckpoint, measureBaseUsage, measureInstanceDisk, verifyBaseCheckpoint } from "./maintenance";
import { settingsFixture } from "./settings.test-fixture";
import { quoteIdentifier as q } from "./validation";

const precedingBaseId = (id: string) => {
  const hex = (BigInt(`0x${id.replaceAll("-", "")}`) - 1n).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const suite = suiteFor("database", "clickhouse");
suite("Pulse accounting and restore checkpoints", () => {
  beforeAll(installFixtureStore, 30_000);
  test("shared stores reject host-dependent disk measurements before querying ClickHouse", async () => {
    await expect(measureInstanceDisk(fixtureStore())).rejects.toThrow("Tests must inject disk measurements");
  });
  test("usage comes from parts and a checkpoint mismatch blocks writes until rechecked or recreated", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      await store.query(
        `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version) VALUES(generateUUIDv4(),generateUUIDv4(),now64(3),1,1)`,
      );
      await measureBaseUsage(base.id, store);
      await measureInstanceDisk({ ...store, query: async () => [{ free_space: 50, total_space: 100 }] });
      const [usage] = await sql`SELECT usage_bytes,usage_rows FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
      const [parts] = await store.query(
        "SELECT sum(bytes_on_disk) AS bytes,sum(rows) AS rows FROM system.parts WHERE active AND database={db:String}",
        { db: base.database },
      );
      expect(Number(usage?.usage_bytes)).toBe(Number(parts?.bytes));
      expect(Number(usage?.usage_rows)).toBe(Number(parts?.rows));
      const original = (await loadStoreRow(base.id))!.checkpoint_id;
      await sql`UPDATE pulse.base_stores SET checkpoint_id='99999999-9999-4999-8999-999999999999' WHERE base_id=${base.id}::uuid`;
      expect(await verifyBaseCheckpoint(base.id, store)).toBe(false);
      expect((await loadStoreRow(base.id))?.write_block_reason).toBe("checkpoint_mismatch");
      expect((await requireBaseWritable(base.id)).ok).toBe(false);
      expect(await ingestBatch({ baseId: base.id, sourceId: crypto.randomUUID(), batch: { events: [{ kind: "blocked" }] } })).toMatchObject(
        { ok: false, error: { code: "PULSE_BASE_WRITE_BLOCKED" } },
      );
      const listed = await listAdminBases(adminFixtureIdentity(), { q: base.shortId });
      expect(listed.items.find((item) => item.id === base.shortId)?.store.writeBlockReason).toBe("checkpoint_mismatch");
      await sql`UPDATE pulse.base_stores SET checkpoint_id=${original}::uuid WHERE base_id=${base.id}::uuid`;
      expect(await verifyBaseCheckpoint(base.id, store, true)).toBe(true);
      expect((await requireBaseWritable(base.id)).ok).toBe(true);
      await admin(`DROP DATABASE ${q(base.database)} SYNC`);
      expect(await verifyBaseCheckpoint(base.id, store)).toBe(false);
      expect((await loadStoreRow(base.id))?.write_block_reason).toBe("database_missing");
      await sql`UPDATE pulse.base_stores SET state='clearing',operation='clear' WHERE base_id=${base.id}::uuid`;
      await createBaseLifecycle(store)(base.id);
      expect((await loadStoreRow(base.id))?.write_block_reason).toBeNull();
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 60_000);
  test("startup verification restores a missing reader with SELECT on its views only", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      await admin(`DROP USER ${q(base.readUser)}`);
      expect(await admin("SELECT name FROM system.users WHERE name={user:String}", { params: { user: base.readUser } })).toEqual([]);
      // Start immediately before this base, so other suites' active bases cannot consume the run.
      const after = precedingBaseId(base.id);
      expect(await runCheckpointScan({ slot: fixtureClock().getTime(), after, checkpointId: null, verifyOnly: true }, store)).toMatchObject(
        {
          after: base.id,
        },
      );
      expect(await admin("SELECT name FROM system.users WHERE name={user:String}", { params: { user: base.readUser } })).toEqual([
        { name: base.readUser },
      ]);
      expect((await admin(`SHOW GRANTS FOR ${q(base.readUser)}`)).map((row) => Object.values(row)[0]).sort()).toEqual(
        READ_VIEWS.map((view) => `GRANT SELECT ON ${base.database}.${view} TO ${base.readUser}`).sort(),
      );
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 60_000);
  test("Clear preserves a blocked base until a Cloud admin recreates it", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`blocked-clear-${base.id}`},'local','user','Clear fixture') RETURNING id`;
    try {
      await createBaseLifecycle(store)(base.id);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
      await store.query(
        `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version) VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',parseDateTime64BestEffort('2026-10-17T12:00:00Z'),1,1)`,
      );
      const original = (await loadStoreRow(base.id))!.checkpoint_id;
      await sql`UPDATE pulse.base_stores SET checkpoint_id='99999999-9999-4999-8999-999999999999' WHERE base_id=${base.id}::uuid`;
      expect(await verifyBaseCheckpoint(base.id, store)).toBe(false);
      expect(await clearBaseData({ baseId: base.id, user: { id: user!.id } })).toMatchObject({
        ok: false,
        error: {
          status: 409,
          code: "PULSE_BASE_WRITE_BLOCKED",
          message:
            "Writes to this base are blocked after a checkpoint mismatch. A Cloud admin decides under Administration -> Pulse -> Bases.",
        },
      });
      expect(submit).not.toHaveBeenCalled();
      expect(await loadStoreRow(base.id)).toMatchObject({ state: "active", operation: null, write_block_reason: "checkpoint_mismatch" });
      const [before] = await store.query(`SELECT count() AS n FROM ${q(base.database)}._samples`);
      expect(Number(before?.n)).toBe(1);
      expect((await sql`SELECT data_clear_started_at FROM pulse.bases WHERE id=${base.id}::uuid`)[0]?.data_clear_started_at).toBeNull();
      expect((await adminBaseAction(adminFixtureIdentity(), base.shortId, "recreate")).store.state).toBe("clearing");
      await createBaseLifecycle(store)(base.id);
      expect(await loadStoreRow(base.id)).toMatchObject({ state: "active", write_block_reason: null });
      expect((await loadStoreRow(base.id))?.checkpoint_id).not.toBe(original);
      const [after] = await store.query(`SELECT count() AS n FROM ${q(base.database)}._samples`);
      expect(Number(after?.n)).toBe(0);
    } finally {
      submit.mockRestore();
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  }, 60_000);
  for (const job of ["usage", "checkpoint"] as const)
    test(`${job} scan advances past a failing base and completes the next base`, async () => {
      const prefix = job === "usage" ? "a1111111" : "b1111111";
      const bases = [
        await fixtureBase(`${prefix}-1111-4111-8111-111111111111`),
        await fixtureBase(`${prefix}-1111-4111-8111-111111111112`),
      ];
      const first = bases[0]!,
        second = bases[1]!,
        store = fixtureStore();
      const visited: string[] = [];
      const failingStore = {
        ...store,
        query: async (...args: Parameters<typeof store.query>) => {
          if (args[0].includes(q(first.database)) || args[1]?.database === first.database) {
            visited.push(first.id);
            throw new Error("FAILING_BASE");
          }
          if (args[0].includes(q(second.database)) || args[1]?.database === second.database) visited.push(second.id);
          return store.query(...args);
        },
      };
      try {
        for (const base of bases) await createBaseLifecycle(store)(base.id);
        // Use a frozen slot after the fixture measurement time, so success remains eligible without the cursor.
        const input = {
          slot: fixtureClock().getTime() + 300_000,
          after: precedingBaseId(first.id),
          checkpointId: "33333333-3333-4333-8333-333333333333",
          verifyOnly: false,
        };
        const run = job === "usage" ? runUsageScan : runCheckpointScan;
        let cursor = await run(input, failingStore);
        expect(cursor?.after).toBe(first.id);
        expect(visited).toEqual([first.id]);
        if (!cursor) throw new Error("MISSING_SCAN_CURSOR");
        cursor = await run(cursor, failingStore);
        expect(cursor?.after).toBe(second.id);
        expect(visited).toContain(second.id);
        if (job === "usage") {
          const [usage] = await sql`SELECT usage_measured_at FROM pulse.base_stores WHERE base_id=${second.id}::uuid`;
          expect(new Date(usage!.usage_measured_at).toISOString()).toBe(fixtureClock().toISOString());
          expect(
            (await sql`SELECT usage_measured_at FROM pulse.base_stores WHERE base_id=${first.id}::uuid`)[0]?.usage_measured_at,
          ).toBeNull();
        } else {
          expect((await loadStoreRow(second.id))?.checkpoint_id).toBe(input.checkpointId);
          expect((await loadStoreRow(first.id))?.checkpoint_id).not.toBe(input.checkpointId);
        }
      } finally {
        for (const base of bases) await cleanupFixtureBase(base);
      }
    }, 60_000);
  test("failed deletes remain in bounded admin pages and retry resumes deleting", async () => {
    const base = await fixtureBase(),
      identity = adminFixtureIdentity();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const settings = settingsFixture();
    try {
      await sql`UPDATE pulse.bases SET deletion_started_at='2026-10-17T12:00:00Z' WHERE id=${base.id}::uuid`;
      await sql`UPDATE pulse.base_stores SET state='failed',operation='delete',attempts=5,usage_bytes=12345 WHERE base_id=${base.id}::uuid`;
      const page = await listAdminBases(identity, { q: base.shortId, limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: base.shortId, store: { state: "failed", operation: "delete" } });
      expect(page.total).toBe(1);
      expect(page.nextOffset).toBeNull();
      expect((await listAdminBases(identity, { q: base.shortId, limit: 1, offset: 1 })).items).toEqual([]);
      const [usage] =
        await sql`SELECT COALESCE(sum(s.usage_bytes),0)::text AS bytes FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id`;
      expect(page.usedBytes).toBe(Number(usage!.bytes));
      const retried = await adminBaseAction(identity, base.shortId, "retry");
      expect(retried.store).toMatchObject({ state: "deleting", operation: "delete" });
      expect(await loadStoreRow(base.id)).toMatchObject({ state: "deleting", operation: "delete" });
      expect((await listAdminBases(identity, { q: base.shortId })).items[0]?.store.state).toBe("deleting");
      expect(submit).toHaveBeenCalledWith(base.id, base.shortId);
    } finally {
      submit.mockRestore();
      settings.restore();
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("a failed delete stays on its base admin's overview, not a reader's, and the admin can resume it", async () => {
    const base = await fixtureBase();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const settings = settingsFixture();
    const users = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`delete-admin-${base.id}`},'local','user','Delete admin'),(${`delete-reader-${base.id}`},'local','user','Delete reader') RETURNING id`;
    const [adminUser, readerUser] = users as [{ id: string }, { id: string }];
    try {
      for (const [user, permission] of [
        [adminUser, "admin"],
        [readerUser, "read"],
      ] as const) {
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access(user_id,permission) VALUES(${user.id}::uuid,${permission}) RETURNING id`;
        await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
      }
      await sql`UPDATE pulse.bases SET deletion_started_at='2026-10-17T12:00:00Z' WHERE id=${base.id}::uuid`;
      await sql`UPDATE pulse.base_stores SET state='failed',operation='delete',attempts=5,last_error='STORE_UNREACHABLE' WHERE base_id=${base.id}::uuid`;
      const admin = { id: adminUser.id },
        reader = { id: readerUser.id };
      const listed = await listDeletingBases(admin);
      expect(listed.ok && listed.data.map((item) => [item.id, item.store.state, item.store.operation])).toEqual([
        [base.id, "failed", "delete"],
      ]);
      expect(await listDeletingBases(reader)).toEqual({ ok: true, data: [] });
      const regular = await listBases(admin);
      expect(regular.ok && regular.data.some((item) => item.id === base.id)).toBe(false);
      expect((await retryBase(base.id, reader)).ok).toBe(false);
      expect(await retryBase(base.id, admin)).toEqual({ ok: true, data: undefined });
      expect(await loadStoreRow(base.id)).toMatchObject({ state: "deleting", operation: "delete" });
      const resumed = await listDeletingBases(admin);
      expect(resumed.ok && resumed.data[0]?.store.state).toBe("deleting");
      expect(submit).toHaveBeenCalledWith(base.id, base.shortId);
    } finally {
      submit.mockRestore();
      settings.restore();
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id IN (${adminUser.id}::uuid,${readerUser.id}::uuid)`;
    }
  }, 30_000);
  test("recreate reapplies schema when a restored database is missing its checkpoint table", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    try {
      await createBaseLifecycle(store)(base.id);
      const original = (await loadStoreRow(base.id))!.checkpoint_id;
      expect((await loadStoreRow(base.id))!.schema_version).toBeGreaterThan(0);
      await admin(`DROP TABLE ${q(base.database)}._checkpoints SYNC`);
      expect(await verifyBaseCheckpoint(base.id, store)).toBe(false);
      expect((await loadStoreRow(base.id))?.write_block_reason).toBe("checkpoint_mismatch");
      expect((await requireBaseWritable(base.id)).ok).toBe(false);
      // An hourly checkpoint whose acceptance failed left a pending id; a clear must not reuse it, or a backup
      // from before the clear would match the Postgres state after it.
      const stale = "0f0f0f0f-0000-4000-8000-000000000001";
      await sql`UPDATE pulse.base_stores SET pending_checkpoint_id=${stale}::uuid WHERE base_id=${base.id}::uuid`;
      expect((await adminBaseAction(adminFixtureIdentity(), base.shortId, "recreate")).store.state).toBe("clearing");
      expect((await loadStoreRow(base.id))?.schema_version).toBe(0);
      expect(submit).toHaveBeenCalledWith(base.id, base.shortId);
      expect(await createBaseLifecycle(store)(base.id)).toEqual({ done: true });
      const row = await loadStoreRow(base.id);
      expect(row).toMatchObject({ state: "active", write_block_reason: null });
      expect(row?.checkpoint_id).toBeTruthy();
      expect(row?.checkpoint_id).not.toBe(original);
      expect(row?.checkpoint_id).not.toBe(stale);
      expect((await requireBaseWritable(base.id)).ok).toBe(true);
      const checkpoints = await store.query(`SELECT toString(id) AS id FROM ${q(base.database)}._checkpoints`);
      expect(checkpoints).toEqual([{ id: row!.checkpoint_id }]);
      expect(await verifyBaseCheckpoint(base.id, store)).toBe(true);
    } finally {
      submit.mockRestore();
      await cleanupFixtureBase(base);
    }
  }, 60_000);
  test("orphan deletion refuses a referenced database and removes only an orphan", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      identity = adminFixtureIdentity();
    try {
      await createBaseLifecycle(store)(base.id);
      await expect(deleteOrphan(identity, base.database, store)).rejects.toMatchObject({ code: "ORPHAN_IN_USE", status: 409 });
      expect((await listOrphans(identity, {}, store)).items).not.toContainEqual({ database: base.database });
      await sql`DELETE FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
      expect((await listOrphans(identity, {}, store)).items).not.toContainEqual({ database: base.database });
      // A base row still reserves its derived name, even if its store row is missing.
      await expect(deleteOrphan(identity, base.database, store)).rejects.toMatchObject({ code: "ORPHAN_IN_USE" });
      await sql`DELETE FROM pulse.bases WHERE id=${base.id}::uuid`;
      expect((await listOrphans(identity, {}, store)).items).toContainEqual({ database: base.database });
      expect(await deleteOrphan(identity, base.database, store)).toEqual({ ok: true });
      expect((await listOrphans(identity, {}, store)).items).not.toContainEqual({ database: base.database });
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("repeated checkpoint acceptance preserves the committed checkpoint", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      const checkpoint = "11111111-1111-4111-8111-111111111111";
      await sql`UPDATE pulse.base_stores SET pending_checkpoint_id=${checkpoint}::uuid WHERE base_id=${base.id}::uuid`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await loadStoreRow(base.id);
        if (!row) throw new Error("MISSING_STORE");
        await acceptCheckpoint(row, sql, store.clock);
      }
      expect((await loadStoreRow(base.id))?.checkpoint_id).toBe(checkpoint);
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("Memory backup and restore retain views; recheck recreates the read user", async () => {
    const base = await fixtureBase(),
      restored = await fixtureBase(),
      store = fixtureStore(),
      session = crypto.randomUUID(),
      backup = `backup_${crypto.randomUUID().replaceAll("-", "")}`;
    const adminSession = (query: string) =>
      clickhouseQuery({ ...clickhouseTestAdmin(), query, settings: { session_id: session }, timeoutMs: 30000 });
    try {
      await createBaseLifecycle(store)(base.id);
      await store.query(`INSERT INTO ${q(base.database)}._events(id,ts,kind,version) VALUES(generateUUIDv4(),now64(3),'restored',1)`);
      await adminSession(`BACKUP DATABASE ${q(base.database)} TO Memory('${backup}')`);
      await createBaseLifecycle(store)(restored.id);
      await adminSession(`DROP DATABASE ${q(restored.database)} SYNC`);
      await adminSession(`DROP USER ${q(restored.readUser)}`);
      const checkpoint = (await loadStoreRow(base.id))!.checkpoint_id;
      await sql`UPDATE pulse.base_stores SET checkpoint_id=${checkpoint}::uuid WHERE base_id=${restored.id}::uuid`;
      await adminSession(`RESTORE DATABASE ${q(base.database)} AS ${q(restored.database)} FROM Memory('${backup}')`);
      expect(await verifyBaseCheckpoint(restored.id, store, true)).toBe(true);
      const credentials = await store.readUserCredentials(restored.id);
      const [row] = await clickhouseQuery({
        ...clickhouseTestAdmin(),
        ...credentials,
        query: `SELECT kind FROM ${q(restored.database)}.events`,
        timeoutMs: 5000,
      });
      expect(row?.kind).toBe("restored");
    } finally {
      await cleanupFixtureBase(base);
      await cleanupFixtureBase(restored);
    }
  }, 60_000);
});
