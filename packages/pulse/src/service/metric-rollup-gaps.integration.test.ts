import { expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { runHourlyRollup } from "./metric-rollups";
import { queryMetricData } from "./query-execution";

const dbTest = process.env.PULSE_METRIC_QUERY_DB_TEST === "1" ? test : test.skip;

dbTest(
  "rollup gaps preserve partial hours, disjoint dirty hours, and missing per-series rollups",
  async () => {
    const baseId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 6 * 3_600_000;
    const time = (hour: number, minute = 0) => new Date(start + hour * 3_600_000 + minute * 60_000).toISOString();
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Rollup gaps')`;
    try {
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Test')`;
      const write = async (hour: number, minute: number, value: number, resource = "a") => {
        const result = await ingestBatch({
          baseId,
          sourceId,
          batch: { metrics: [{ name: "load", value, ts: time(hour, minute), resource: { type: "host", id: resource } }] },
        });
        if (!result.ok) throw Error(result.error.message);
      };
      for (let hour = 0; hour < 5; hour++) {
        await write(hour, 10, hour * 100 + 10);
        await write(hour, 50, hour * 100 + 30);
        await write(hour, 10, hour * 100 + 70, "b");
      }
      for (let hour = 0; hour < 5; hour++) await runHourlyRollup(baseId);
      expect((await runHourlyRollup(baseId)).done).toBe(true);
      const read = async (from: string, to: string, resource = "a") => {
        const result = await queryMetricData({
          kind: "metric",
          baseId,
          metric: "load",
          aggregation: "avg",
          bucket: "1h",
          from,
          to,
          dimensions: {},
          resourceKey: `host:${resource}`,
        });
        if (!result.ok) throw Error(result.error.message);
        return result.data.map((point) => point.value);
      };
      expect(await read(time(0), time(5))).toEqual([20, 120, 220, 320, 420]);
      expect(await read(time(0, 30), time(4, 30))).toEqual([30, 120, 220, 320, 410]);
      await write(1, 10, 150);
      await write(3, 10, 350);
      expect(await read(time(0), time(5))).toEqual([20, 140, 220, 340, 420]);
      await sql`DELETE FROM pulse.metric_rollups_hourly r USING pulse.metric_series s
      WHERE r.series_id=s.id AND s.base_id=${baseId}::uuid AND s.resource_key='host:a' AND r.bucket=${time(2)}::timestamptz`;
      const [hour] = await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${baseId}::uuid AND hour=${time(2)}::timestamptz`;
      expect(hour?.state).toBe("clean");
      expect(await read(time(0), time(5))).toEqual([20, 140, 220, 340, 420]);
      expect(await read(time(0), time(5), "b")).toEqual([70, 170, 270, 370, 470]);
      const together = await queryMetricData({
        kind: "metric",
        baseId,
        metric: "load",
        aggregation: "avg",
        bucket: "1h",
        from: time(0),
        to: time(5),
        dimensions: {},
        groupBy: "resource",
      });
      if (!together.ok) throw Error(together.error.message);
      expect(
        together.data
          .map(({ bucket, value, group }) => ({ bucket, value, resource: group?.resource_key }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket) || String(a.resource).localeCompare(String(b.resource))),
      ).toEqual(
        [20, 140, 220, 340, 420].flatMap((value, hour) => [
          { bucket: time(hour), value, resource: "host:a" },
          { bucket: time(hour), value: hour * 100 + 70, resource: "host:b" },
        ]),
      );
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60_000,
);
