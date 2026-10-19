import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SQL, sql } from "bun";
import { requireInfra, suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { installIngestControlsFixture } from "./ingest-controls.test-fixture";

if (testInfra.database && testInfra.valkey && testInfra.clickhouse) {
  await requireInfra("database", "valkey", "clickhouse");
  await installIngestControlsFixture();
}
const { createIngestWriter } = await import("./ingest-writer");
const { runMetricsSourceScrape } = await import("./metrics-scraper");
const { dueMetricsSources } = await import("./runtime");
const { writeFixture } = await import("./write.test-fixture");
const { getSource, updateSource, createSource } = await import("./source-management");
const { encryptSecret } = await import("@k2b/cloud/services");

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse scrape write transactions", () => {
  test("scrapes exceed a two-connection pool without nested reservations; one source has one claimant", async () => {
    const f = await writeFixture("scrape-small-pool");
    const database = new SQL({ max: 2 });
    const ids = Array.from({ length: 6 }, (_, i) => `40000000-0000-4000-8000-00000000000${i}`);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requests = 0;
    const endpoint = Bun.serve({
      port: 0,
      fetch: async () => {
        requests++;
        entered();
        await gate;
        return new Response("# TYPE probe gauge\nprobe 42\n");
      },
    });
    const pending: Promise<unknown>[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const id of ids)
        await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,endpoint_url,scrape_interval_seconds)
        VALUES(${id}::uuid,${id.replaceAll("-", "").slice(-6)},${f.base.id}::uuid,'metrics','Pool fixture',${`http://127.0.0.1:${endpoint.port}/metrics`},60)`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      const deps = { database, clock: f.clock, ingestBatch: createIngestWriter({ database, store: f.store, clock: f.clock }) };
      const scrape = (sourceId: string) => runMetricsSourceScrape({ baseId: f.base.id, sourceId }, deps);
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Scrapes starved the SQL pool")), 10000);
      });
      const first = scrape(ids[0]!);
      pending.push(first);
      await Promise.race([
        arrived,
        deadline,
        first.then(() => {
          throw new Error("Scrape finished before fetching");
        }),
      ]);
      expect(await Promise.race([scrape(ids[0]!), deadline])).toMatchObject({ ok: false, error: { status: 409 } });
      expect(requests).toBe(1);
      const rest = ids.slice(1).map(scrape);
      pending.push(...rest);
      release();
      const results = await Promise.race([Promise.all([first, ...rest]), deadline]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(requests).toBe(ids.length);
      expect(await sql`SELECT id FROM pulse.sources WHERE base_id=${f.base.id}::uuid AND scrape_lease_until IS NOT NULL`).toHaveLength(0);
      expect(await f.read("samples", "count() AS n")).toEqual([{ n: ids.length }]);
    } finally {
      clearTimeout(timeout);
      release();
      endpoint.stop(true);
      await database.close({ timeout: 1 });
      await Promise.allSettled(pending);
      await f.cleanup();
    }
  }, 30000);
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

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse scrape families and source contracts", () => {
  test("#4 real Traefik v3 histogram buckets reach samples/series views; refused families and summaries replace diagnostics", async () => {
    const f = await writeFixture("traefik");
    let text = await readFile(`${import.meta.dir}/fixtures/traefik-v3.prom`, "utf8");
    const endpoint = Bun.serve({ port: 0, fetch: () => new Response(text) });
    try {
      await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url=${`http://127.0.0.1:${endpoint.port}/metrics`},scrape_interval_seconds=60 WHERE id=${f.sourceId}::uuid`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      const scrape = () =>
        runMetricsSourceScrape(
          { baseId: f.base.id, sourceId: f.sourceId },
          { clock: f.clock, ingestBatch: createIngestWriter({ store: f.store, clock: f.clock }) },
        );
      expect((await scrape()).ok).toBe(true);
      const buckets = await f.read(
        "samples m JOIN " + '"' + f.base.database + '".series s ON m.series_id=s.series_id',
        "s.metric,s.type,s.dimensions,m.value",
        "WHERE s.metric='traefik_entrypoint_request_duration_seconds_bucket'",
      );
      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets.every((row) => row.type === "counter")).toBe(true);
      expect(buckets.some((row) => JSON.parse(String(row.dimensions)).le === "+Inf")).toBe(true);
      expect(buckets.some((row) => JSON.parse(String(row.dimensions)).le === "0.1")).toBe(true);
      const [source] = await sql<
        { refused_histograms: { family: string; reason: string }[]; skipped_summaries: number }[]
      >`SELECT refused_histograms,skipped_summaries FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(source?.refused_histograms).toEqual([]);
      expect(source?.skipped_summaries).toBe(7);
      text =
        '# TYPE missing histogram\nmissing_bucket{le="1"} 1\n# TYPE falling histogram\nfalling_bucket{le="1"} 5\nfalling_bucket{le="+Inf"} 3\n# TYPE ignored summary\nignored{quantile="0.5"} 1\nignored_sum 2\nignored_count 3';
      f.setTime("2026-10-17T12:01:00Z");
      expect((await scrape()).ok).toBe(true);
      const [refused] = await sql<
        { refused_histograms: { family: string; reason: string }[]; skipped_summaries: number }[]
      >`SELECT refused_histograms,skipped_summaries FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(refused?.refused_histograms).toEqual([
        { family: "missing", reason: "missing_inf" },
        { family: "falling", reason: "not_cumulative" },
      ]);
      expect(refused?.skipped_summaries).toBe(3);
      expect(await f.read("series", "metric", "WHERE metric LIKE 'missing%' OR metric LIKE 'falling%'")).toEqual([]);
      text = "# TYPE up gauge\nup 1";
      expect((await scrape()).ok).toBe(true);
      expect(
        await sql<
          { refused_histograms: { family: string; reason: string }[]; skipped_summaries: number }[]
        >`SELECT refused_histograms,skipped_summaries FROM pulse.sources WHERE id=${f.sourceId}::uuid`,
      ).toEqual([{ refused_histograms: [], skipped_summaries: 0 }]);
    } finally {
      endpoint.stop(true);
      await f.cleanup();
    }
  }, 60000);

  test("#12 family filters precede sample/series caps, and source status uses the supplied request clock", async () => {
    const f = await writeFixture("filtered"),
      userId = "20000000-0000-4000-8000-000000000001";
    const text =
      "# TYPE excluded gauge\n" +
      Array.from({ length: 50001 }, (_, i) => `excluded{key="${i}"} 1`).join("\n") +
      "\n# TYPE keep_one gauge\nkeep_one 1\n# TYPE node_cpu_seconds_total counter\nnode_cpu_seconds_total 2";
    const endpoint = Bun.serve({ port: 0, fetch: () => new Response(text) });
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,${userId},'local','user')`;
      const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${f.base.id}::uuid,${access!.id}::uuid)`;
      await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url=${`http://127.0.0.1:${endpoint.port}/metrics`},scrape_interval_seconds=60 WHERE id=${f.sourceId}::uuid`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      await sql`UPDATE pulse.base_stores SET max_series=2 WHERE base_id=${f.base.id}::uuid`;
      const updated = await updateSource({
        baseId: f.base.id,
        sourceId: f.sourceId,
        user: { id: userId },
        metricFilters: ["keep_one", "node_*"],
      });
      expect(updated.ok && updated.data.metricFilters).toEqual(["keep_one", "node_*"]);
      expect(
        (
          await runMetricsSourceScrape(
            { baseId: f.base.id, sourceId: f.sourceId },
            { clock: f.clock, ingestBatch: createIngestWriter({ store: f.store, clock: f.clock }) },
          )
        ).ok,
      ).toBe(true);
      expect(await f.read("series", "metric", "ORDER BY metric")).toEqual([{ metric: "keep_one" }, { metric: "node_cpu_seconds_total" }]);
      await sql`UPDATE pulse.sources SET throttled_at=${f.clock()} WHERE id=${f.sourceId}::uuid`;
      const source = await getSource(f.sourceId, { id: userId }, f.clock());
      expect(source.ok && source.data.status).toMatchObject({
        newestDataAt: f.clock().toISOString(),
        throttled: true,
        throttledAt: f.clock().toISOString(),
        refusedHistograms: [],
        skippedSummaries: 0,
        lastError: null,
      });
      const stale = await getSource(f.sourceId, { id: userId }, new Date("2026-10-17T12:05:00Z"));
      expect(stale.ok && stale.data.status.throttled).toBe(false);
      expect(
        await updateSource({ baseId: f.base.id, sourceId: f.sourceId, user: { id: userId }, metricFilters: ["bad*name"] }),
      ).toMatchObject({ ok: false, error: { status: 400 } });
      expect(
        await createSource({ baseId: f.base.id, user: { id: userId }, kind: "http_ingest", name: "wrong", metricFilters: [] }),
      ).toMatchObject({ ok: false, error: { status: 400 } });
    } finally {
      endpoint.stop(true);
      await f.cleanup();
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 60000);

  test("#11 changing a metrics origin removes the token; a path change preserves it", async () => {
    const f = await writeFixture("origin"),
      userId = "20000000-0000-4000-8000-000000000002";
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${userId}::uuid,${userId},'local','user')`;
      const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${f.base.id}::uuid,${access!.id}::uuid)`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      const token = await encryptSecret("fixture-bearer");
      await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url='http://127.0.0.1:9100/metrics',bearer_token_encrypted=${token} WHERE id=${f.sourceId}::uuid`;
      const patch = (endpointUrl: string, bearerToken?: string) =>
        updateSource({ baseId: f.base.id, sourceId: f.sourceId, user: { id: userId }, endpointUrl, bearerToken });
      expect((await patch("http://127.0.0.1:9100/other")).ok).toBe(true);
      expect((await sql`SELECT bearer_token_encrypted FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.bearer_token_encrypted).toBe(
        token,
      );
      expect((await patch("http://127.0.0.1:9200/metrics")).ok).toBe(true);
      expect(
        (await sql`SELECT bearer_token_encrypted FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.bearer_token_encrypted,
      ).toBeNull();
      expect((await patch("http://127.0.0.1:9300/metrics", "replacement")).ok).toBe(true);
      expect(
        (await sql`SELECT bearer_token_encrypted FROM pulse.sources WHERE id=${f.sourceId}::uuid`)[0]?.bearer_token_encrypted,
      ).toBeTruthy();
    } finally {
      await f.cleanup();
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 60000);
});
