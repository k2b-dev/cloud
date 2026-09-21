import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { runHourlyRollup, sealExpiredMetricHour } from "./metric-rollups";
import { queryMetricData } from "./query-execution";

const dbTest = testFor("database");

dbTest(
  "rollups catch up beyond 48 hours, recompute overwrites, merge raw head, and seal without history loss",
  async () => {
    const baseId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days) VALUES(${baseId}::uuid,${newShortId()},'Rollup proof',30)`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Test')`;
    const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 72 * 3600000);
    const first = new Date(+hour + 60000).toISOString(),
      second = new Date(+hour + 120000).toISOString();
    const write = async (ts: string, value: number) => ingestBatch({ baseId, sourceId, batch: { metrics: [{ name: "load", value, ts }] } });
    const query = {
      kind: "metric" as const,
      baseId,
      metric: "load",
      aggregation: "avg" as const,
      bucket: "1h",
      since: "7d",
      dimensions: {},
    };
    try {
      expect((await write(first, 10)).ok).toBe(true);
      expect((await write(second, 30)).ok).toBe(true);
      expect(await runHourlyRollup(baseId)).toMatchObject({ buckets: 1, done: false });
      expect((await runHourlyRollup(baseId)).done).toBe(true);
      let result = await queryMetricData(query);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.map((p) => p.value)).toEqual([20]);
      expect((await write(first, 50)).ok).toBe(true);
      result = await queryMetricData(query);
      if (!result.ok) throw Error("query failed");
      expect(result.data.map((p) => p.value)).toEqual([40]);
      const concurrent = await Promise.all([runHourlyRollup(baseId), write(first, 50), runHourlyRollup(baseId)]);
      expect(concurrent[1].ok).toBe(true);
      await runHourlyRollup(baseId);
      expect((await write(new Date().toISOString(), 90)).ok).toBe(true);
      result = await queryMetricData(query);
      if (!result.ok) throw Error("query failed");
      expect(result.data.map((p) => p.value)).toEqual([40, 90]);
      await sql`UPDATE pulse.bases SET retention_days=1 WHERE id=${baseId}::uuid`;
      expect(await sealExpiredMetricHour(baseId)).toBe(1);
      expect((await write(first, 99)).ok).toBe(false);
      await sql`DELETE FROM pulse.metric_samples WHERE base_id=${baseId}::uuid AND ts<${new Date(+hour + 3600000)}`;
      result = await queryMetricData(query);
      expect(result.ok).toBe(false);
      const historical = { ...query, since: undefined, from: hour.toISOString(), to: new Date(+hour + 3600000).toISOString() };
      const exact = await queryMetricData(historical);
      if (!exact.ok) throw Error(exact.error.message);
      expect(exact.data.map((p) => p.value)).toEqual([40]);
      expect((await queryMetricData({ ...historical, to: new Date(+hour + 1800000).toISOString() })).ok).toBe(false);
      expect((await queryMetricData({ ...query, aggregation: "p95" })).ok).toBe(false);
      const [rollup] = await sql`SELECT value_sum,sample_count,last_value FROM pulse.metric_rollups_hourly WHERE base_id=${baseId}::uuid`;
      expect(Number(rollup?.value_sum)).toBe(80);
      expect(Number(rollup?.sample_count)).toBe(2);
      expect(Number(rollup?.last_value)).toBe(30);
      await sql`UPDATE pulse.bases SET retention_days=30 WHERE id=${baseId}::uuid`;
      expect((await write(first, 99)).ok).toBe(false);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60000,
);

dbTest(
  "catalog retention removes expired metadata but preserves resources referenced by current state",
  async () => {
    const { pruneCatalogBatch } = await import("./catalog-retention");
    const baseId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Catalog proof')`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Test')`;
    try {
      const resource = { type: "host", id: "retained" };
      expect(
        (
          await ingestBatch({
            baseId,
            sourceId,
            batch: {
              metrics: [{ name: "load", value: 1, resource, dimensions: { region: "eu" } }],
              states: [{ key: "online", value: true, resource, dimensions: { region: "eu" } }],
            },
          })
        ).ok,
      ).toBe(true);
      await sql`UPDATE pulse.metric_series SET last_seen_at=now()-interval '40 days' WHERE base_id=${baseId}::uuid`;
      await sql`UPDATE pulse.observed_resources SET last_seen_at=now()-interval '40 days' WHERE base_id=${baseId}::uuid`;
      await sql`UPDATE pulse.signal_fields SET last_seen_at=now()-interval '40 days' WHERE base_id=${baseId}::uuid`;
      expect(await pruneCatalogBatch(baseId, 50000)).toBe(0);
      await sql`DELETE FROM pulse.metric_samples WHERE base_id=${baseId}::uuid`;
      for (let i = 0; i < 5; i++) {
        if ((await pruneCatalogBatch(baseId, 50000)) === 0) break;
      }
      const [remaining] = await sql`SELECT
    (SELECT count(*)::int FROM pulse.metric_series WHERE base_id=${baseId}::uuid) AS series,
    (SELECT count(*)::int FROM pulse.metric_defs WHERE base_id=${baseId}::uuid) AS defs,
    (SELECT count(*)::int FROM pulse.signal_fields WHERE base_id=${baseId}::uuid AND scope='metric') AS metric_fields,
    (SELECT count(*)::int FROM pulse.signal_fields WHERE base_id=${baseId}::uuid AND scope='state') AS state_fields,
    (SELECT count(*)::int FROM pulse.observed_resources WHERE base_id=${baseId}::uuid) AS resources`;
      expect(remaining).toEqual({ series: 0, defs: 0, metric_fields: 0, state_fields: 1, resources: 1 });
      await sql`DELETE FROM pulse.states_current WHERE base_id=${baseId}::uuid`;
      expect(await pruneCatalogBatch(baseId, 50000)).toBe(2);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60000,
);
