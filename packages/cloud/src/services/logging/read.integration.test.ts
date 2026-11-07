import { expect, test } from "bun:test";
import { Hono } from "hono";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { logging, trace, withObservabilityRead } from "./index";
import { readQuery } from "./read";

const suite = databaseSuite();
suite("bounded observability reads", () => {
  test("summaries and default listings exclude historical sources and abandoned spans", async () => {
    const source = `read-${crypto.randomUUID()}`;
    try {
      // A large retained history, all well outside the 24h window. Relative
      // intervals share the database clock; no assertion depends on today's date.
      await sql`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, started_at)
        SELECT ${source}, n::text, 'old', ${source}, now() - interval '400 days' FROM generate_series(1, 100001) n`;
      await sql`INSERT INTO logging.entries(source, message, created_at)
        SELECT ${source}, 'old', now() - interval '400 days' FROM generate_series(1, 100001)`;
      const [stats, listed, sources, logs, summary, logSources] = await withObservabilityRead(new AbortController().signal, () =>
        Promise.all([
          trace.stats({ filter: { source } }),
          trace.list({ page: 1, perPage: 10, offset: 0 }, { filter: { source } }),
          trace.sources(),
          logging.list({ page: 1, perPage: 10, offset: 0 }, { source }),
          trace.summary(),
          logging.getSources(),
        ]),
      );
      expect(stats.runs).toBe(0);
      expect(stats.stuck).toBe(0);
      expect(listed.total).toBe(0);
      expect(logs.total).toBe(0);
      expect(sources).not.toContain(source);
      expect(logSources).not.toContain(source);
      expect(Number.isFinite(summary.total)).toBe(true);
      expect(summary.total).toBeGreaterThanOrEqual(0);
      await sql`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, started_at)
        VALUES (${source}, 'stuck', 'stuck', ${source}, now() - interval '2 hours')`;
      for (const window of ["10m", "1h"] as const) {
        expect((await trace.stats({ filter: { source, window } })).stuck).toBe(1);
      }
    } finally {
      await sql`DELETE FROM logging.trace_spans WHERE source=${source}`;
      await sql`DELETE FROM logging.entries WHERE source=${source}`;
    }
  });

  test("aborting an HTTP request cancels PostgreSQL work and leaves its connection usable", async () => {
    const marker = `observability_sleep_${crypto.randomUUID().replaceAll("-", "")}`;
    const app = new Hono()
      .use("*", (c, next) => withObservabilityRead(c.req.raw.signal, next))
      .get("/", async (c) => {
        await readQuery((db) => db.unsafe(`SELECT pg_sleep(30) /* ${marker} */`));
        return c.text("done");
      })
      .onError(() => new Response("cancelled", { status: 499 }));
    const controller = new AbortController();
    const response = app.request("http://test/", { signal: controller.signal });
    let pid: number | undefined;
    const deadline = performance.now() + 3000;
    try {
      while (!pid && performance.now() < deadline) {
        const [active] = await sql<
          { pid: number }[]
        >`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND position(${marker} in query)>0`;
        pid = active?.pid;
        if (!pid) await Bun.sleep(10);
      }
      expect(pid).toBeDefined();
      const start = performance.now();
      controller.abort();
      expect((await response).status).toBe(499);
      expect(performance.now() - start).toBeLessThan(1500);
      const [active] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=${pid ?? 0} AND state='active' AND position(${marker} in query)>0`;
      expect(active?.count).toBe(0);
      expect(await readQuery((db) => db<{ ready: number }[]>`SELECT 1 AS ready`)).toEqual([{ ready: 1 }]);
    } finally {
      controller.abort();
      await response;
    }
  });
});
