import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { requireBaseActive } from "./access-control";
import { prepareIngestBatch, writePreparedIngestBatchInTransaction } from "./ingest-bulk";
import { ingestBatch } from "./ingest-writer";

const dbTest = testFor("database");

dbTest(
  "different sources can update existing shared metric definitions before another writer commits",
  async () => {
    const baseId = crypto.randomUUID(),
      sources = [crypto.randomUUID(), crypto.randomUUID()];
    const ts = new Date().toISOString();
    const batch = (id: string, value: number) => ({
      metrics: [{ name: "shared", unit: "count", value, ts, resource: { type: "server", id } }],
    });
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Concurrent existing metrics')`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<unknown> | undefined, second: ReturnType<typeof ingestBatch> | undefined;
    try {
      for (const [index, source] of sources.entries()) {
        await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${source}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Test')`;
        expect((await ingestBatch({ baseId, sourceId: source, batch: batch(String(index), 1) })).ok).toBe(true);
      }
      let ready!: () => void;
      const acquired = new Promise<void>((resolve) => {
        ready = resolve;
      });
      first = sql.begin(async (tx) => {
        const active = await requireBaseActive(baseId, tx);
        if (!active.ok) throw Error(active.error.message);
        await tx`SELECT id FROM pulse.sources WHERE id=${sources[0]}::uuid FOR NO KEY UPDATE`;
        await writePreparedIngestBatchInTransaction({
          baseId,
          sourceId: sources[0]!,
          batch: prepareIngestBatch(batch("0", 2), sources[0]!),
          db: tx,
        });
        ready();
        await held;
      });
      await Promise.race([
        acquired,
        first.then(() => {
          throw Error("First transaction ended before the barrier");
        }),
      ]);
      second = ingestBatch({ baseId, sourceId: sources[1]!, batch: batch("1", 3) });
      const result = await Promise.race([second, Bun.sleep(5000).then(() => null)]);
      expect(result?.ok).toBe(true);
      release();
      await first;
      const values = await sql<
        { value: number }[]
      >`SELECT s.value FROM pulse.metric_samples s JOIN pulse.metric_series series ON series.id=s.series_id
      WHERE s.base_id=${baseId}::uuid ORDER BY series.resource_key`;
      expect(values.map((row) => row.value)).toEqual([2, 3]);
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  30000,
);

dbTest(
  "concurrent definition creation validates immutable units and rolls back unused definitions",
  async () => {
    const baseId = crypto.randomUUID();
    const sources = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Concurrent metric definitions')`;
    try {
      for (const source of sources)
        await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name)
      VALUES(${source}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Test')`;
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state)
      VALUES(${baseId}::uuid,date_bin('1 hour',now(),'1970-01-01'::timestamptz),'dirty')`;
      const results = await Promise.all(
        sources.map((sourceId, index) =>
          ingestBatch({
            baseId,
            sourceId,
            batch: {
              metrics: [
                { name: "new.metric", unit: index === 0 ? "count" : "bytes", value: 1 },
                { name: `only-${index}`, value: 1 },
              ],
            },
          }),
        ),
      );
      expect(results.filter((result) => result.ok).length).toBe(1);
      const rejected = results.find((result) => !result.ok);
      expect(rejected?.error.message).toContain("Metric type and unit must match");
      const accepted = results.findIndex((result) => result.ok);
      const definitions = await sql`SELECT name,unit FROM pulse.metric_defs WHERE base_id=${baseId}::uuid ORDER BY name`;
      expect(definitions).toEqual([
        { name: "new.metric", unit: accepted === 0 ? "count" : "bytes" },
        { name: `only-${accepted}`, unit: null },
      ]);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  30000,
);
