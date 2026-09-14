import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { MetricQuery } from "../contracts";
import { newShortId } from "../lib/short-id";
import { queryMetricData } from "./query-execution";

const runDbSmoke = process.env.PULSE_METRIC_QUERY_DB_TEST === "1";
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 30_000);

describe("Pulse grouped metric query Postgres smoke", () => {
  postgresTest("aggregates per series before grouping and reducing", async () => {
    const baseId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Metric query smoke')`;
    await sql`
      INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
      VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Metric query source')
    `;

    try {
      const [definition] = await sql<{ id: string }[]>`
        INSERT INTO pulse.metric_defs (base_id, name, unit, type)
        VALUES (${baseId}::uuid, 'docker.compose.service.cpu.usage', 'percent', 'gauge'::pulse.metric_type)
        RETURNING id
      `;
      if (!definition) throw new Error("Metric definition fixture was not created");
      const series = [];
      for (const [service, label] of [
        ["api", "API"],
        ["worker", "Worker"],
      ] as const) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO pulse.metric_series (
            base_id, metric_id, source_id, series_key, dimensions_hash, dimensions,
            resource_key, resource_id, resource_type, resource_label, last_seen_at
          ) VALUES (
            ${baseId}::uuid, ${definition.id}::uuid, ${sourceId}::uuid, ${service}, ${service},
            (${JSON.stringify({ compose_service: service })}::jsonb #>> '{}')::jsonb,
            ${`docker-compose-service:test:${service}`}, ${`test:${service}`}, 'docker-compose-service', ${label}, now()
          )
          RETURNING id
        `;
        if (!row) throw new Error("Metric series fixture was not created");
        series.push(row.id);
      }
      const first = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_000_000);
      const second = new Date(first.getTime() + 60_000);
      for (const [seriesId, values] of [
        [series[0]!, [10, 20]],
        [series[1]!, [5, 15]],
      ] as const) {
        await sql`
          INSERT INTO pulse.metric_samples (base_id, series_id, ts, value)
          VALUES (${baseId}::uuid, ${seriesId}::uuid, ${first}, ${values[0]}),
                 (${baseId}::uuid, ${seriesId}::uuid, ${second}, ${values[1]})
        `;
      }

      const baseQuery: MetricQuery = {
        kind: "metric",
        baseId,
        metric: "docker.compose.service.cpu.usage",
        aggregation: "avg",
        bucket: "1h",
        since: "1d",
        dimensions: {},
      };
      const grouped = await queryMetricData({ ...baseQuery, groupBy: "resource" });
      expect(grouped.ok).toBe(true);
      if (!grouped.ok) return;
      expect(grouped.data.map((point) => ({ group: point.group?.resource, value: point.value }))).toEqual([
        { group: "API", value: 15 },
        { group: "Worker", value: 10 },
      ]);

      // Exercise warmed connections while independent transactions compete for the pool.
      const reads = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        await sql.begin(async (tx) => { await tx`SELECT ${index}::int`; });
        return queryMetricData({ ...baseQuery, aggregation: "latest", reduce: "sum" });
      }));
      expect(reads.every(result => result.ok && result.data[0]?.value === 35)).toBe(true);

      const totalLatest = await queryMetricData({ ...baseQuery, aggregation: "latest", reduce: "sum" });
      expect(totalLatest.ok).toBe(true);
      if (!totalLatest.ok) return;
      expect(totalLatest.data[0]?.value).toBe(35);

      const totalRate = await queryMetricData({ ...baseQuery, aggregation: "rate", bucket: "1d", reduce: "sum" });
      expect(totalRate.ok).toBe(false);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
