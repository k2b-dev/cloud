import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { listAdminBases } from "./base-admin";
import { createRetention } from "./retention";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor("database", "clickhouse")("Pulse sealed raw partition retention", () => {
  beforeAll(installFixtureStore, 30000);
  test("#7 sealed hours reject writes, whole days require sealing, and lag reaches the admin contract", async () => {
    const f = await writeFixture("retention"),
      run = createRetention({ store: f.store });
    const ts = "2026-10-14T10:05:00Z";
    try {
      await f.stopMerges();
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts }] }));
      await sql`UPDATE pulse.bases SET retention_days=1 WHERE id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date("2026-10-14T12:00:00Z")},updated_at=${new Date("2026-10-14T10:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      const blocked = await run(f.base.id);
      expect(blocked.rawPartitions).toBe(0);
      expect(Number((await f.read("samples", "count() AS n"))[0]?.n)).toBe(1);
      const admin = await listAdminBases(adminFixtureIdentity(), { q: f.base.shortId }, f.clock);
      expect(admin.items[0]?.rollupLag).toBe(true);
      // Rollup completion alone is insufficient until the writer lease has expired.
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=${new Date(f.clock().getTime() + 60000)} WHERE base_id=${f.base.id}::uuid`;
      expect((await run(f.base.id)).rawPartitions).toBe(0);
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      const dropped = await run(f.base.id);
      expect(dropped.sealedHours).toBe(1);
      expect(dropped.rawPartitions).toBe(1);
      expect(Number((await f.read("samples", "count() AS n"))[0]?.n)).toBe(0);
      // Widen retention again: the persisted seal still refuses a write even though the timestamp is now in range.
      await sql`UPDATE pulse.bases SET retention_days=30 WHERE id=${f.base.id}::uuid`;
      expect(await f.write({ metrics: [{ name: "load", value: 2, ts }] })).toMatchObject({
        ok: false,
        error: { status: 400, message: expect.stringContaining("sealed") },
      });
      expect((await listAdminBases(adminFixtureIdentity(), { q: f.base.shortId }, f.clock)).items[0]?.rollupLag).toBe(false);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("registries and scrape history expire but current state keys remain", async () => {
    const f = await writeFixture("registry-retention");
    try {
      assertWrite(
        await f.write({ metrics: [{ name: "load", value: 1 }], events: [{ kind: "opened" }], states: [{ key: "door", value: true }] }),
      );
      await sql`UPDATE pulse.metric_series SET last_seen_at=${new Date("2025-01-01T00:00:00Z")},last_sample_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.event_kinds SET last_seen_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.state_keys SET first_seen_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      const result = await createRetention({ store: f.store })(f.base.id);
      expect(result.registryRecords).toBe(3); // series, definition, event kind
      const [key] = await sql`SELECT state_key FROM pulse.state_keys WHERE base_id=${f.base.id}::uuid`;
      expect(key?.state_key).toBe("door");
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
