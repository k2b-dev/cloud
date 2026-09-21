import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { queryMetricData } from "./query-execution";

const enabled = testInfra.database !== undefined;
const postgresTest = enabled ? test : test.skip;
beforeAll(async () => {
  if (enabled) await (await import("../schema")).initializeSchema();
}, 30000);

describe("observed counter pairs", () => {
  postgresTest(
    "handles resets before reduction, boundary predecessors, elapsed weighting and missing pairs",
    async () => {
      const baseId = crypto.randomUUID(),
        sourceId = crypto.randomUUID();
      await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Counter proof')`;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Probe')`;
      const anchor = Math.floor(Date.now() / 3600000) * 3600000 - 7200000;
      const write = async (name: string, values: number[], seconds: number[], resource: string) =>
        ingestBatch({
          baseId,
          sourceId,
          batch: {
            metrics: values.map((value, i) => ({
              name,
              value,
              type: "counter",
              ts: new Date(anchor + seconds[i]! * 1000).toISOString(),
              resource: { type: "host", id: resource },
            })),
          },
        });
      const query = async (metric: string, aggregation: "increase" | "rate" | "p95", bucket = "1d", since = "1d") =>
        queryMetricData({ kind: "metric", baseId, metric, aggregation, bucket, since, dimensions: {}, reduce: "sum" });
      try {
        expect((await write("resets", [100, 110, 3, 8], [0, 60, 120, 180], "a")).ok).toBe(true);
        expect((await write("resets", [20, 22, 25, 29], [0, 60, 120, 180], "b")).ok).toBe(true);
        expect(await query("resets", "increase")).toMatchObject({ ok: true, data: [{ value: 27 }] });
        const rate = await query("resets", "rate");
        expect(rate.ok).toBe(true);
        if (rate.ok) expect(rate.data[0]?.value).toBeCloseTo(0.15);
        expect((await query("resets", "p95")).ok).toBe(false);
        expect((await write("irregular", [0, 10, 20], [0, 10, 110], "a")).ok).toBe(true);
        const irregular = await query("irregular", "rate");
        expect(irregular.ok).toBe(true);
        if (irregular.ok) expect(irregular.data[0]?.value).toBeCloseTo(20 / 110);
        expect((await write("single", [7], [0], "a")).ok).toBe(true);
        expect(await query("single", "increase")).toMatchObject({ ok: true, data: [{ value: null }] });
        expect(await query("single", "rate")).toMatchObject({ ok: true, data: [{ value: null }] });
        expect((await write("constant", [7, 7], [0, 60], "a")).ok).toBe(true);
        expect(await query("constant", "increase")).toMatchObject({ ok: true, data: [{ value: 0 }] });
        const now = Date.now();
        expect(
          (
            await ingestBatch({
              baseId,
              sourceId,
              batch: {
                metrics: [
                  { name: "boundary", type: "counter", value: 100, ts: new Date(now - 3700000).toISOString() },
                  { name: "boundary", type: "counter", value: 110, ts: new Date(now - 3500000).toISOString() },
                ],
              },
            })
          ).ok,
        ).toBe(true);
        expect(await query("boundary", "increase", "1h", "1h")).toMatchObject({ ok: true, data: [{ value: 10 }] });
        const split = await query("resets", "increase", "1m");
        expect(split.ok).toBe(true);
        if (split.ok) expect(split.data.map((p) => p.value)).toEqual([null, 12, 6, 9]);
        const mismatch = await ingestBatch({
          baseId,
          sourceId,
          batch: { metrics: [{ name: "resets", type: "gauge", value: 1 }], events: [{ kind: "must.rollback" }] },
        });
        expect(mismatch.ok).toBe(false);
        const [count] = await sql`SELECT count(*)::int AS count FROM pulse.events WHERE base_id=${baseId}::uuid`;
        expect(count.count).toBe(0);
        expect(
          (await ingestBatch({ baseId, sourceId, batch: { metrics: [{ name: "resets", type: "counter", unit: "seconds", value: 1 }] } }))
            .ok,
        ).toBe(false);
        expect(
          (
            await ingestBatch({
              baseId,
              sourceId,
              batch: {
                metrics: [
                  { name: "conflict", type: "counter", value: 1 },
                  { name: "conflict", type: "gauge", value: 1 },
                ],
              },
            })
          ).ok,
        ).toBe(false);
        expect((await ingestBatch({ baseId, sourceId, batch: { metrics: [{ name: "negative", type: "counter", value: -1 }] } })).ok).toBe(
          false,
        );
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      }
    },
    30000,
  );
});
