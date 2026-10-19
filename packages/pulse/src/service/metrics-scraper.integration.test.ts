import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { createIngestWriter } from "./ingest-writer";
import { runMetricsSourceScrape } from "./metrics-scraper";
import { dueMetricsSources } from "./runtime";
import { writeFixture } from "./write.test-fixture";

suiteFor("database", "clickhouse")("Pulse scrape write transactions", () => {
  beforeAll(installFixtureStore, 30000);
  test("a scrape commits T1 independently, stores in ClickHouse, and keeps endpoint failures on the configured interval", async () => {
    const f = await writeFixture("scrape");
    let available = true;
    const endpoint = Bun.serve({
      port: 0,
      fetch: () => (available ? new Response("# TYPE probe gauge\nprobe 42\n") : new Response("unavailable", { status: 503 })),
    });
    try {
      await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url=${`http://127.0.0.1:${endpoint.port}/metrics`},scrape_interval_seconds=3600 WHERE id=${f.sourceId}::uuid`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      const deps = { clock: f.clock, ingestBatch: createIngestWriter({ store: f.store, clock: f.clock }) };
      expect(await runMetricsSourceScrape({ baseId: f.base.id, sourceId: f.sourceId }, deps)).toEqual({
        ok: true,
        data: { metrics: 1, events: 0, states: 0 },
      });
      expect(await f.read("samples", "value")).toEqual([{ value: 42 }]);
      available = false;
      f.setTime("2026-10-17T13:00:00Z");
      expect((await runMetricsSourceScrape({ baseId: f.base.id, sourceId: f.sourceId }, deps)).ok).toBe(false);
      const [source] = await sql`SELECT last_error,last_scrape_slot_at FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(source?.last_error).toBeTruthy();
      expect(source?.last_scrape_slot_at.toISOString()).toBe(f.clock().toISOString());
      expect((await dueMetricsSources(Date.parse("2026-10-17T13:01:00Z"))).find((s) => s.id === f.sourceId)).toBeUndefined();
      const scrapes = await sql<
        { duration_ms: number }[]
      >`SELECT duration_ms FROM pulse.source_scrapes WHERE source_id=${f.sourceId}::uuid`;
      expect(scrapes.map((s) => s.duration_ms)).toEqual([0, 0]);
    } finally {
      endpoint.stop(true);
      await f.cleanup();
    }
  }, 60000);
});
