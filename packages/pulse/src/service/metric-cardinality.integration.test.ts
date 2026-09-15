import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { PulseMetric } from "../contracts";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { PULSE_METRIC_SERIES_LIMIT } from "./metric-cardinality";

const runDbSmoke = process.env.PULSE_METRIC_CARDINALITY_DB_TEST === "1";
const postgresTest = runDbSmoke ? test : test.skip;

beforeAll(async () => {
  if (!runDbSmoke) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
}, 60_000);

describe("Pulse metric cardinality Postgres smoke", () => {
  postgresTest(
    "admits one concurrent final series and keeps existing series writable",
    async () => {
      const baseId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      const otherSourceId = crypto.randomUUID();
      const metricName = "cardinality.concurrent";
      await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Metric cardinality smoke')`;
      await sql`
      INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
      VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Metric cardinality source')
    `;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name)
        VALUES(${otherSourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Other source')`;

      try {
        const [definition] = await sql<{ id: string }[]>`
        INSERT INTO pulse.metric_defs (base_id, name, unit, type)
        VALUES (${baseId}::uuid, ${metricName}, 'count', 'gauge'::pulse.metric_type)
        RETURNING id
      `;
        if (!definition) throw new Error("Metric definition fixture was not created");
        await sql`
        INSERT INTO pulse.metric_series (
          base_id, metric_id, source_id, resource_key, series_key, dimensions_hash, dimensions, last_seen_at
        )
        SELECT
          ${baseId}::uuid,
          ${definition.id}::uuid,
          ${sourceId}::uuid,
          'seed-' || value,
          'seed-' || value,
          'seed-' || value,
          '{}'::jsonb,
          now()
        FROM generate_series(1, ${PULSE_METRIC_SERIES_LIMIT - 1}) value
      `;

        const candidates: PulseMetric[] = [
          { name: metricName, value: 1, unit: "count", resource: { type: "host", id: "candidate-a" }, dimensions: { shard: "a" } },
          { name: metricName, value: 1, unit: "count", resource: { type: "host", id: "candidate-b" }, dimensions: { shard: "b" } },
        ];
        await sql`INSERT INTO pulse.metric_hours(base_id,hour,state)
          VALUES(${baseId}::uuid,date_bin('1 hour',now(),'1970-01-01'::timestamptz),'dirty')`;
        const candidateSources = [sourceId, otherSourceId];
        const results = await Promise.all(
          candidates.map((metric, index) => ingestBatch({ baseId, sourceId: candidateSources[index]!, batch: { metrics: [metric] } })),
        );

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const rejected = results.find((result) => !result.ok);
        expect(rejected?.error.message).toContain(`limit of ${PULSE_METRIC_SERIES_LIMIT} series`);

        const [seriesCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pulse.metric_series
        WHERE metric_id = ${definition.id}::uuid
      `;
        expect(seriesCount?.count).toBe(PULSE_METRIC_SERIES_LIMIT);

        const acceptedIndex = results.findIndex((result) => result.ok);
        const repeated = await ingestBatch({
          baseId,
          sourceId: candidateSources[acceptedIndex]!,
          batch: { metrics: [candidates[acceptedIndex]!] },
        });
        expect(repeated.ok).toBe(true);
        const newSingle = await ingestBatch({
          baseId,
          sourceId,
          batch: {
            metrics: [
              { name: metricName, value: 1, unit: "count", resource: { type: "host", id: "candidate-c" }, dimensions: { shard: "c" } },
            ],
          },
        });
        expect(newSingle.ok).toBe(false);
        if (newSingle.ok) throw new Error("Expected a metric cardinality failure");
        expect(newSingle.error.message).toContain(`limit of ${PULSE_METRIC_SERIES_LIMIT} series`);
      } finally {
        await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
      }
    },
    60_000,
  );
});
