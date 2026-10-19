import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { valueHash } from "./ingest-bulk";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse state decisions and timestamp validation", () => {
  beforeAll(installFixtureStore, 30000);
  test("#5 a 2099 state cannot poison the current state; all collections enforce 4:59/5:01", async () => {
    const f = await writeFixture("timestamps");
    try {
      await f.stopMerges();
      expect(await f.write({ states: [{ key: "door", value: "future", ts: "2099-01-01T00:00:00Z" }] })).toMatchObject({
        ok: false,
        error: { status: 400, message: expect.stringContaining('states[0] (key "door")') },
      });
      assertWrite(await f.write({ states: [{ key: "door", value: "now" }] }));
      expect(await f.read("states", "value")).toEqual([{ value: '"now"' }]);
      for (const collection of ["metrics", "events", "states"] as const) {
        const item =
          collection === "metrics"
            ? { name: "load", value: 1 }
            : collection === "events"
              ? { kind: "opened" }
              : { key: "boundary", value: true };
        const accepted = { [collection]: [{ ...item, ts: "2026-10-17T12:04:59Z" }] };
        assertWrite(await f.write(accepted));
        expect(await f.write({ [collection]: [{ ...item, ts: "2026-10-17T12:05:01Z" }] })).toMatchObject({
          ok: false,
          error: { status: 400, message: expect.stringContaining(`${collection}[0]`) },
        });
      }
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("a stale pending acceptance cannot rewind an equal-timestamp state, even with a frozen millisecond", async () => {
    const f = await writeFixture("state-acceptance-order");
    try {
      await f.stopMerges();
      const ts = "2026-10-17T10:00:00Z";
      assertWrite(await f.write({ states: [{ key: "door", value: "open", ts }] }));
      const oldBatch = { states: [{ key: "door", value: "closed", ts }] };
      await sql`INSERT INTO pulse.ingest_idempotency(source_id,idempotency_key,request_hash,state,accepted_at,created_at,expires_at)
        VALUES(${f.sourceId}::uuid,'older',${valueHash(oldBatch)},'pending',${new Date(f.clock().getTime() - 1)},${f.clock()},${new Date(f.clock().getTime() + 86400000)})`;
      assertWrite(await f.write(oldBatch, "older"));
      expect(await f.read("states", "value")).toEqual([{ value: '"open"' }]);
      expect(Number((await f.read("_state_changes", "count() AS n"))[0]?.n)).toBe(1);
      assertWrite(await f.writeB(oldBatch, "later")); // clock deliberately stays on the same millisecond
      expect(await f.read("states", "value")).toEqual([{ value: '"closed"' }]);
      const [variant] = await sql`SELECT value_hash FROM pulse.state_variants WHERE base_id=${f.base.id}::uuid`;
      expect(variant?.value_hash).toBe(valueHash("closed"));
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("equal timestamps use later acceptance, older states do nothing, changes need a changed value", async () => {
    const f = await writeFixture("states");
    try {
      await f.stopMerges();
      const ts = "2026-10-17T10:00:00Z";
      assertWrite(await f.write({ states: [{ key: "door", value: "closed", ts }] }, "one"));
      f.setTime("2026-10-17T12:00:00.001Z");
      assertWrite(await f.writeB({ states: [{ key: "door", value: "open", ts }] }, "two"));
      expect(await f.read("states", "value")).toEqual([{ value: '"open"' }]);
      f.setTime("2026-10-17T12:00:00.002Z");
      assertWrite(await f.write({ states: [{ key: "door", value: "closed", ts: "2026-10-17T09:59:59Z" }] }));
      assertWrite(await f.write({ states: [{ key: "door", value: "open", ts: "2026-10-17T10:01:00Z" }] }));
      assertWrite(
        await f.write({
          states: [
            { key: "door", value: "closed", ts: "2026-10-17T10:02:00Z" },
            { key: "door", value: "closed", ts: "2026-10-17T10:03:00Z" },
          ],
        }),
      );
      const [count] = await f.read("_state_changes", "count() AS n");
      expect(Number(count?.n)).toBe(3);
      expect(
        await f
          .read("states", "value,toUnixTimestamp64Milli(updated_at) AS ts")
          .then((rows) => rows.map((r) => ({ value: r.value, ts: Number(r.ts) }))),
      ).toEqual([{ value: '"closed"', ts: Date.parse("2026-10-17T10:03:00Z") }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
});

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse physical state replacement ordering", () => {
  beforeAll(installFixtureStore, 30000);
  test("timestamp priority survives a physical merge and replay of schema v2", async () => {
    const f = await writeFixture("state-physical-order");
    const { BASE_SCHEMA_VERSIONS } = await import("../store/base-schema");
    const { quoteIdentifier: q } = await import("../store/validation");
    const { clickhouseAdminQuery } = await import("../../../../scripts/fixtures/test-clickhouse");
    try {
      await f.store.query(`INSERT INTO ${q(f.base.database)}._states_current(state_key,variant_key,value,updated_at,version) VALUES
        ('door','variant','"newer"','2026-10-17 10:00:00',1),('door','variant','"older"','2026-10-17 09:00:00',2)`);
      expect(await f.read("states", "value")).toEqual([{ value: '"newer"' }]);
      await clickhouseAdminQuery(`OPTIMIZE TABLE ${q(f.base.database)}._states_current FINAL`);
      expect(await f.read("states", "value")).toEqual([{ value: '"newer"' }]);
      for (const statement of BASE_SCHEMA_VERSIONS[1]!.statements({
        database: f.base.database,
        prefix: f.store.prefix,
        rawRetentionDays: 30,
        rollupRetentionDays: 365,
        sensitiveRetentionHours: 24,
      }))
        await f.store.query(statement);
      expect(await f.read("states", "value")).toEqual([{ value: '"newer"' }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
