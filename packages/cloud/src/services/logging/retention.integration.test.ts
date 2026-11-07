import { expect, spyOn, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { logging } from "./index";
import type { RetentionProgress } from "./retention";

const suite = databaseSuite();
suite("logging retention", () => {
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
      await expect(logging.cleanup(30, { signal: abort.signal })).rejects.toThrow();
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
      await sql`INSERT INTO logging.entries(source, message, created_at)
        SELECT ${source}, 'expired', '2026-09-01'::timestamptz FROM generate_series(1, 10001)`;
      const budget = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30001);
      try {
        const first = await logging.cleanup(30, {
          onProgress: async (value) => {
            progress.push(value);
          },
        });
        expect(first.deleted).toBe(10000);
      } finally {
        budget.mockRestore();
      }
      expect(progress).toEqual([{ entries: 10000, complete: false }]);
      await logging.cleanup(30);
      const [left] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM logging.entries WHERE source=${source}`;
      expect(left?.count).toBe(0);
    } finally {
      clock.mockRestore();
      await sql`DELETE FROM logging.entries WHERE source=${source}`;
    }
  });
});
