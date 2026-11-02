import { expect, spyOn, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { logging, trace } from "./index";
import type { RetentionProgress } from "./retention";

const suite = databaseSuite();
suite("logging retention", () => {
  test("drains multiple bounded batches including abandoned spans and high-fanout events", async () => {
    const source = `retention-${crypto.randomUUID()}`;
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T12:00:00Z"));
    const progress: RetentionProgress[] = [];
    let heartbeats = 0;
    try {
      await sql`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, started_at, ended_at)
        SELECT ${source}, n::text, 'expired', ${source}, '2026-09-01'::timestamptz,
          CASE WHEN n = 1 THEN NULL ELSE '2026-09-02'::timestamptz END
        FROM generate_series(1, 10001) n`;
      await sql`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, started_at, ended_at) VALUES
        (${source}, 'recent', 'recent', ${source}, '2026-10-31', '2026-10-31'),
        (${source}, 'running', 'running', ${source}, '2026-10-31', NULL),
        (${source}, 'long', 'recently ended', ${source}, '2026-09-01', '2026-10-31')`;
      await sql`INSERT INTO logging.trace_events(trace_id, span_id, name)
        SELECT ${source}, n::text, 'event' FROM generate_series(1, 10001) n CROSS JOIN generate_series(1, 3)`;
      const deleted = await trace.cleanup({
        days: 30,
        source,
        heartbeat: async () => {
          heartbeats++;
        },
        onProgress: async (value) => {
          progress.push(value);
        },
      });
      expect(deleted).toBe(10001);
      expect(heartbeats).toBe(progress.length);
      expect(progress.at(-1)).toEqual({ events: 30003, spans: 10001, complete: true });
      for (let i = 0; i < progress.length; i++) {
        expect((progress[i]!.events ?? 0) - (progress[i - 1]?.events ?? 0)).toBeLessThanOrEqual(10000);
        expect((progress[i]!.spans ?? 0) - (progress[i - 1]?.spans ?? 0)).toBeLessThanOrEqual(10000);
      }
      const remaining = await sql<{ span_id: string }[]>`SELECT span_id FROM logging.trace_spans WHERE source=${source} ORDER BY span_id`;
      expect(remaining.map((row) => row.span_id)).toEqual(["long", "recent", "running"]);
    } finally {
      clock.mockRestore();
      await sql`DELETE FROM logging.trace_spans WHERE source=${source}`;
    }
  });

  test("log cleanup heartbeats after each bounded transaction and preserves recent rows", async () => {
    const source = `retention-${crypto.randomUUID()}`;
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T12:00:00Z"));
    const progress: RetentionProgress[] = [];
    let heartbeats = 0;
    try {
      await sql`INSERT INTO logging.entries(source, message, created_at)
        SELECT ${source}, 'expired', '2026-09-01'::timestamptz FROM generate_series(1, 10001)`;
      await sql`INSERT INTO logging.entries(source, message, created_at) VALUES (${source}, 'recent', '2026-10-31')`;
      const result = await logging.cleanup(30, {
        heartbeat: async () => {
          heartbeats++;
        },
        onProgress: async (value) => {
          progress.push(value);
        },
      });
      expect(result.deleted).toBeGreaterThanOrEqual(10001);
      expect(heartbeats).toBeGreaterThanOrEqual(2);
      expect(progress.at(-1)?.complete).toBe(true);
      for (let i = 0; i < progress.length; i++)
        expect((progress[i]!.entries ?? 0) - (progress[i - 1]?.entries ?? 0)).toBeLessThanOrEqual(10000);
      const rows = await sql<{ message: string }[]>`SELECT message FROM logging.entries WHERE source=${source}`;
      expect(rows).toEqual([{ message: "recent" }]);
      await expect(logging.cleanup(0)).rejects.toThrow("positive");
      const abort = new AbortController();
      abort.abort();
      await expect(trace.cleanup({ days: 30, source, signal: abort.signal })).rejects.toThrow();
    } finally {
      clock.mockRestore();
      await sql`DELETE FROM logging.entries WHERE source=${source}`;
    }
  });
  test("a pass yields at its budget and the next pass resumes the committed backlog", async () => {
    const source = `retention-budget-${crypto.randomUUID()}`;
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T12:00:00Z"));
    const progress: RetentionProgress[] = [];
    try {
      await sql`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, started_at)
        SELECT ${source}, n::text, 'expired', ${source}, '2026-09-01'::timestamptz FROM generate_series(1, 10001) n`;
      const budget = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30001);
      try {
        expect(
          await trace.cleanup({
            days: 30,
            source,
            onProgress: async (value) => {
              progress.push(value);
            },
          }),
        ).toBe(10000);
      } finally {
        budget.mockRestore();
      }
      expect(progress).toEqual([{ events: 0, spans: 10000, complete: false }]);
      expect(await trace.cleanup({ days: 30, source })).toBe(1);
    } finally {
      clock.mockRestore();
      await sql`DELETE FROM logging.trace_spans WHERE source=${source}`;
    }
  });
});
