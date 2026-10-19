import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { deterministicRowId } from "./ingest-bulk";
import { createIngestWriter } from "./ingest-writer";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse control-plane registry caps", () => {
  beforeAll(installFixtureStore, 30000);
  test("series per metric/base, kinds, keys, and write blocking refuse whole batches", async () => {
    const f = await writeFixture("caps");
    try {
      await sql`UPDATE pulse.base_stores SET max_series=1,max_event_kinds=1,max_state_keys=1 WHERE base_id=${f.base.id}::uuid`;
      assertWrite(
        await f.write({ metrics: [{ name: "load", value: 1 }], events: [{ kind: "opened" }], states: [{ key: "door", value: true }] }),
      );
      for (const batch of [
        { metrics: [{ name: "other", value: 1 }] },
        { events: [{ kind: "other" }] },
        { states: [{ key: "other", value: true }] },
      ]) {
        expect(await f.write(batch)).toMatchObject({ ok: false, error: { status: 400, message: expect.stringContaining("limit of 1") } });
      }
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.event_kinds WHERE base_id=${f.base.id}::uuid`).toEqual([
        { kind: "opened" },
      ]);
      await sql`UPDATE pulse.base_stores SET max_series=20000 WHERE base_id=${f.base.id}::uuid`;
      const [def] = await sql<{ id: string }[]>`SELECT id FROM pulse.metric_defs WHERE base_id=${f.base.id}::uuid AND name='load'`;
      await sql`INSERT INTO pulse.metric_series(base_id,metric_id,source_id,series_key,created_at)
        SELECT ${f.base.id}::uuid,${def!.id}::uuid,${f.sourceId}::uuid,'seed-'||i,${f.clock()} FROM generate_series(1,9999) i`;
      expect(await f.write({ metrics: [{ name: "load", value: 2, dimensions: { new: "series" } }] })).toMatchObject({
        ok: false,
        error: { status: 400, message: expect.stringContaining("10000 series") },
      });
      await sql`UPDATE pulse.base_stores SET write_block_reason='checkpoint_mismatch' WHERE base_id=${f.base.id}::uuid`;
      expect(await f.write({ events: [{ kind: "opened" }] })).toMatchObject({ ok: false, error: { code: "PULSE_BASE_WRITE_BLOCKED" } });
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("two source instances racing for the final series cap admit only one", async () => {
    const f = await writeFixture("cap-race");
    try {
      await sql`UPDATE pulse.base_stores SET max_series=1 WHERE base_id=${f.base.id}::uuid`;
      const sourceB = deterministicRowId(f.sourceId, "cap-race", "source", 1);
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,created_at,updated_at)
        VALUES(${sourceB}::uuid,${sourceB.replaceAll("-", "").slice(0, 6)},${f.base.id}::uuid,'http_ingest','Other source',${f.clock()},${f.clock()})`;
      const writeOtherSource = createIngestWriter({ store: f.other, clock: f.clock });
      const values = await Promise.all([
        f.write({ metrics: [{ name: "load", value: 1, dimensions: { key: "a" } }] }),
        writeOtherSource({
          baseId: f.base.id,
          sourceId: sourceB,
          batch: { metrics: [{ name: "load", value: 1, dimensions: { key: "b" } }] },
        }),
      ]);
      expect(values.filter((r) => r.ok)).toHaveLength(1);
      expect(values.find((r) => !r.ok)).toMatchObject({ ok: false, error: { status: 400 } });
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
