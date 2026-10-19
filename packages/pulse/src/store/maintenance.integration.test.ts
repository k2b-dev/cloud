import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery as admin, clickhouseTestAdmin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { requireBaseWritable } from "../service/access-control";
import { deleteOrphan, listAdminBases, listOrphans } from "../service/base-admin";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { ingestBatch } from "../service/ingest-writer";
import { adminFixtureIdentity } from "./admin-identity.test-fixture";
import { loadStoreRow } from "./base-store";
import { cleanupFixtureBase, fixtureBase, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { clickhouseQuery } from "./client";
import { acceptCheckpoint, measureBaseUsage, measureInstanceDisk, verifyBaseCheckpoint } from "./maintenance";
import { quoteIdentifier as q } from "./validation";

const suite = suiteFor("database", "clickhouse");
suite("Pulse accounting and restore checkpoints", () => {
  beforeAll(installFixtureStore, 30_000);
  test("usage comes from parts and a checkpoint mismatch blocks writes until rechecked or recreated", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      await store.query(
        `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version) VALUES(generateUUIDv4(),generateUUIDv4(),now64(3),1,1)`,
      );
      await measureBaseUsage(base.id, store);
      await measureInstanceDisk(store);
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
  test("orphan deletion refuses a referenced database and removes only an orphan", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      identity = adminFixtureIdentity();
    try {
      await createBaseLifecycle(store)(base.id);
      await expect(deleteOrphan(identity, base.database, store)).rejects.toMatchObject({ code: "ORPHAN_IN_USE", status: 409 });
      expect((await listOrphans(identity, {}, store)).items).not.toContainEqual({ database: base.database });
      await sql`DELETE FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
      expect((await listOrphans(identity, {}, store)).items).toContainEqual({ database: base.database });
      // A base row still reserves its derived name, even if its store row is missing.
      await expect(deleteOrphan(identity, base.database, store)).rejects.toMatchObject({ code: "ORPHAN_IN_USE" });
      await sql`DELETE FROM pulse.bases WHERE id=${base.id}::uuid`;
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
