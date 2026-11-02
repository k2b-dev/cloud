import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/logging";
import { sql } from "../../runtime/clients";
import { SYNC_SLOW_AFTER_MS, trace } from "./trace";

const suite = databaseSuite();
const at = new Date("2026-11-02T12:00:00Z");

suite("trace retention after upgrading a large success history", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("trace_retention");
    await migrate();
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("size pressure removes newer routine successes before older problems and minute counts", async () => {
    const source = "upgrade";
    const failed = await trace.complete({ source, name: "failure", status: "error", startedAt: at, endedAt: at });
    const recovered = await trace.complete({ source, name: "recovered", startedAt: at, endedAt: at });
    await trace.record({ context: recovered, event: "sync.retry", severity: "warn" });
    const slow = await trace.complete({ source, name: "slow", startedAt: at, endedAt: new Date(at.getTime() + SYNC_SLOW_AFTER_MS) });
    const routine = await trace.complete({ source, name: "routine", startedAt: at, endedAt: new Date(at.getTime() + 1) });
    const active = await trace.start({ source, name: "active", startedAt: at });
    await sql`INSERT INTO logging.run_minutes VALUES (${at}, ${at}, ${source}, 'test', 'job', 'routine', 1000, 1000, 1, ARRAY[1000]::bigint[])`;
    const [size] = await sql<Array<{ bytes: string }>>`SELECT (
      (SELECT SUM(pg_column_size(ROW(s.*))) FROM logging.trace_spans s WHERE source = ${source} AND name <> 'routine')
      + (SELECT SUM(pg_column_size(ROW(e.*))) FROM logging.trace_events e)
      + (SELECT SUM(pg_column_size(ROW(r.*))) FROM logging.run_minutes r WHERE source = ${source})
    )::text AS bytes`;
    expect(await trace.cleanup({ source, days: 365_000, maxBytes: Number(size!.bytes) })).toBe(1);
    expect(await trace.getSpan(routine)).toBeNull();
    for (const kept of [failed, recovered, slow, active]) expect(await trace.getSpan(kept)).not.toBeNull();
    expect(await sql`SELECT 1 FROM logging.run_minutes WHERE source = ${source}`).toHaveLength(1);
  });

  test("problems are bounded too after the routine successes are gone", async () => {
    const source = "problem-budget";
    const failed = await trace.complete({ source, name: "failure", status: "error", startedAt: at, endedAt: at });
    const routine = await trace.complete({ source, name: "routine", startedAt: at, endedAt: at });
    const active = await trace.start({ source, name: "active", startedAt: at });
    const [size] = await sql<
      Array<{ bytes: number }>
    >`SELECT pg_column_size(ROW(s.*)) AS bytes FROM logging.trace_spans s WHERE trace_id = ${active.traceId}`;
    expect(await trace.cleanup({ source, days: 365_000, maxBytes: size!.bytes })).toBe(2);
    expect(await trace.getSpan(failed)).toBeNull();
    expect(await trace.getSpan(routine)).toBeNull();
    expect(await trace.getSpan(active)).not.toBeNull();
  });

  test("payload accounting heartbeats between primary-key pages of at most 10000 rows", async () => {
    await sql`INSERT INTO logging.trace_spans (trace_id, span_id, name, source)
      SELECT 'count-' || lpad(i::text, 5, '0'), 'span', 'active', 'count-pages' FROM generate_series(1, 10001) i`;
    await sql`INSERT INTO logging.trace_events (trace_id, span_id, name)
      SELECT 'count-00001', 'span', 'detail' FROM generate_series(1, 10001)`;
    let heartbeats = 0;
    expect(
      await trace.cleanup({
        source: "count-pages",
        days: 365_000,
        maxBytes: 2 ** 40,
        heartbeat: async () => {
          heartbeats++;
        },
      }),
    ).toBe(0);
    // Two age-delete pages, two span pages, two event pages, one minute page.
    expect(heartbeats).toBe(7);
    const controller = new AbortController();
    heartbeats = 0;
    await expect(
      trace.cleanup({
        source: "count-pages",
        days: 365_000,
        maxBytes: 2 ** 40,
        signal: controller.signal,
        heartbeat: async () => {
          if (++heartbeats === 3) controller.abort(new Error("stop counting"));
        },
      }),
    ).rejects.toThrow("stop counting");
    expect(heartbeats).toBe(3);
  });

  test("invalid byte budgets warn and still remove expired rows", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const [index, budget] of [0, 1.5, Number.NaN].entries()) {
        const source = `invalid-${index}`;
        const expired = await trace.complete({ source, name: "expired", startedAt: at, endedAt: at });
        await sql`UPDATE logging.trace_spans SET ended_at = now() - INTERVAL '2 days' WHERE trace_id = ${expired.traceId}`;
        const recent = await trace.complete({ source, name: "recent", startedAt: at, endedAt: at });
        await sql`UPDATE logging.trace_spans SET ended_at = now() WHERE trace_id = ${recent.traceId}`;
        expect(await trace.cleanup({ source, days: 1, maxBytes: budget })).toBe(1);
        expect(await trace.getSpan(expired)).toBeNull();
        expect(await trace.getSpan(recent)).not.toBeNull();
      }
      expect(warning).toHaveBeenCalledTimes(3);
    } finally {
      warning.mockRestore();
    }
  });
});
