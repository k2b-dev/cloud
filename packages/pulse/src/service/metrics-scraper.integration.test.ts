import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/cloud/server";
import { SQL, sql } from "bun";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { runMetricsSourceScrape } from "./metrics-scraper";
import { dueMetricsSources } from "./runtime";

const enabled = process.env.PULSE_METRICS_SCRAPER_DB_TEST === "1";
const postgresTest = enabled ? test : test.skip;

let endpoint: ReturnType<typeof Bun.serve> | undefined;
let baseId = "";
let sourceId = "";

beforeAll(async () => {
  if (!enabled) return;
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
  endpoint = Bun.serve({
    port: 0,
    fetch: () => new Response("# TYPE scrape_probe gauge\nscrape_probe 1\n", { headers: { "content-type": "text/plain" } }),
  });
  baseId = crypto.randomUUID();
  sourceId = crypto.randomUUID();
  await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${baseId}::uuid, ${newShortId()}, 'Scraper outcome smoke')`;
  await sql`
    INSERT INTO pulse.sources (id, short_id, base_id, kind, name, endpoint_url)
    VALUES (${sourceId}::uuid, ${newShortId()}, ${baseId}::uuid, 'metrics'::pulse.source_kind, 'Probe', ${`http://127.0.0.1:${endpoint.port}/metrics`})
  `;
}, 60_000);

afterAll(async () => {
  if (baseId) await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
  endpoint?.stop(true);
});

const lastError = async (): Promise<string | null> => {
  const [row] = await sql<{ last_error: string | null }[]>`SELECT last_error FROM pulse.sources WHERE id = ${sourceId}::uuid`;
  return row?.last_error ?? null;
};

describe("metrics scrape outcomes", () => {
  postgresTest("records endpoint and input failures as scrape outcomes but throws on ingest infrastructure failures", async () => {
    const rejected = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async () => fail(err.badInput("Metric series limit reached")) },
    );
    expect(rejected).toMatchObject({ ok: false, error: { status: 400 } });
    expect(await lastError()).toBe("Metric series limit reached");

    await expect(
      runMetricsSourceScrape({ baseId, sourceId }, { ingestBatch: async () => fail(err.internal("Failed to ingest Pulse batch")) }),
    ).rejects.toThrow("Metrics ingest failed: Failed to ingest Pulse batch");
    // Infrastructure failures are left to the job retry; the source keeps its last real outcome.
    expect(await lastError()).toBe("Metric series limit reached");

    const accepted = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async ({ batch }) => ok({ metrics: batch.metrics?.length ?? 0, events: 0, states: 0 }) },
    );
    expect(accepted).toEqual({ ok: true, data: { metrics: 1, events: 0, states: 0 } });
    expect(await lastError()).toBeNull();

    const unreachableEndpoint = endpoint;
    unreachableEndpoint?.stop(true);
    const unreachable = await runMetricsSourceScrape(
      { baseId, sourceId },
      { ingestBatch: async () => ok({ metrics: 0, events: 0, states: 0 }) },
    );
    expect(unreachable.ok).toBe(false);
    expect(await lastError()).not.toBeNull();
  });
});

postgresTest(
  "minute slots stay due after slow completion and scrape work uses one pool connection",
  async () => {
    const base = crypto.randomUUID(),
      source = crypto.randomUUID();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        requests++;
        await Bun.sleep(50);
        return new Response("# TYPE probe gauge\nprobe 1\n");
      },
    });
    const database = new SQL({ url: process.env.DATABASE_URL!, max: 1 });
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${base}::uuid,${newShortId()},'Scrape cadence')`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,endpoint_url,scrape_interval_seconds) VALUES(${source}::uuid,${newShortId()},${base}::uuid,'metrics','Probe',${`http://127.0.0.1:${server.port}`},60)`;
    try {
      const start = Math.floor(Date.now() / 60000) * 60000;
      for (const slotTs of [start, start + 60000, start + 120000]) {
        expect((await dueMetricsSources(slotTs)).some((row) => row.id === source)).toBe(true);
        const result = await runMetricsSourceScrape({ baseId: base, sourceId: source, slotTs }, { database, ingestBatch });
        expect(result.ok).toBe(true);
        expect((await dueMetricsSources(slotTs)).some((row) => row.id === source)).toBe(false);
      }
      expect(requests).toBe(3);
      const results = await Promise.all(
        [0, 1, 2].map(() => runMetricsSourceScrape({ baseId: base, sourceId: source }, { database, ingestBatch })),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      const [count] = await sql`SELECT count(*)::int AS count FROM pulse.metric_samples WHERE base_id=${base}::uuid`;
      expect(count.count).toBe(6);
      const [sample] = await sql`SELECT resource_key FROM pulse.metric_series WHERE base_id=${base}::uuid`;
      expect(sample.resource_key).toBe(`target:127.0.0.1:${server.port}`);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      server.reload({
        async fetch() {
          entered.resolve();
          await release.promise;
          return new Response("# TYPE probe gauge\nprobe 2\n");
        },
      });
      const first = runMetricsSourceScrape({ baseId: base, sourceId: source }, { ingestBatch });
      try {
        await entered.promise;
        const overlapping = await runMetricsSourceScrape({ baseId: base, sourceId: source }, { ingestBatch });
        expect(overlapping).toMatchObject({ ok: false, error: { status: 409 } });
      } finally {
        release.resolve();
        await first;
      }
      await sql`UPDATE pulse.sources SET enabled=false WHERE id=${source}::uuid`;
      expect((await runMetricsSourceScrape({ baseId: base, sourceId: source }, { ingestBatch })).ok).toBe(false);
    } finally {
      await database.close();
      server.stop(true);
      await sql`DELETE FROM pulse.bases WHERE id=${base}::uuid`;
    }
  },
  60000,
);
