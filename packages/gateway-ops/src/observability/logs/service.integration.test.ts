import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { logging } from "@k2b/cloud/services";
import { meterSql, type SqlMeter } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { loggingService } from "./service";

const suite = databaseSuite();

suite("log list search", () => {
  const source = `ops-logs-${crypto.randomUUID()}`;
  const other = `${source}-other`;
  let meter: SqlMeter;
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;

  beforeAll(async () => {
    database = await useFreshDatabase("gateway_ops_logs");
    // The log table as core's migration creates it (packages/core/src/migrate/core/logging.ts).
    await sql`CREATE SCHEMA logging`;
    await sql`
      CREATE TABLE logging.entries (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        level TEXT NOT NULL DEFAULT 'info',
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      INSERT INTO logging.entries (level, source, message, metadata, created_at)
      VALUES
        ('error', ${source}, 'SMTP timeout after 30 s', '{"requestId":"7f3a9c","durationMs":30004}'::jsonb, now() - interval '2 minutes'),
        ('warn',  ${source}, 'Greylisting at example.org', '{"request_id":"cc5031"}'::jsonb, now() - interval '3 minutes'),
        ('info',  ${source}, 'Delivered 100% of 3', NULL, now() - interval '4 minutes'),
        ('error', ${other},  'Upstream timeout', '{"requestId":"7f3a9c"}'::jsonb, now() - interval '5 minutes'),
        ('error', ${source}, 'Old failure', NULL, now() - interval '3 hours')
    `;
    meter = await meterSql();
  });
  afterAll(async () => {
    await meter?.close();
    await database?.drop();
  });

  const since = () => new Date(Date.now() - 15 * 60_000);

  test("filters by window, levels, sources, text and request ID, newest first, with counts per level", async () => {
    const all = await loggingService.entry.search({ since: since(), sources: [source, other] });
    expect(all.entries.map((entry) => entry.message)).toEqual([
      "SMTP timeout after 30 s",
      "Greylisting at example.org",
      "Delivered 100% of 3",
      "Upstream timeout",
    ]);
    expect(all.levels).toEqual({ debug: 0, info: 1, warn: 1, error: 2 });
    expect(all.total).toBe(4);
    expect(all.entries[0]).toMatchObject({ level: "error", source, metadata: { requestId: "7f3a9c", durationMs: 30004 } });

    const errors = await loggingService.entry.search({ since: since(), sources: [source, other], levels: ["error", "warn"], request: "7f3a9c" });
    expect(errors.entries.map((entry) => entry.message)).toEqual(["SMTP timeout after 30 s", "Upstream timeout"]);

    // `%` and `_` in a search are text, not patterns.
    const literal = await loggingService.entry.search({ since: since(), sources: [source], search: "100%" });
    expect(literal.entries.map((entry) => entry.message)).toEqual(["Delivered 100% of 3"]);

    const ended = await loggingService.entry.search({ since: new Date(Date.now() - 4 * 3_600_000), until: since(), sources: [source] });
    expect(ended.entries.map((entry) => entry.message)).toEqual(["Old failure"]);
  });

  test("one page costs what the list cost before v2: two reads of the log table, one when nothing matches", async () => {
    const reads = (statements: string[]) => statements.filter((statement) => statement.includes("FROM logging.entries"));
    const page = await meter.during(() => loggingService.entry.search({ since: since(), sources: [source], levels: ["error"] }));
    const before = await meter.during(() => logging.list({ page: 1, perPage: 100, offset: 0 }, { sources: [source], level: "error", sinceHours: 1 }));
    expect(reads(page)).toHaveLength(2);
    expect(reads(page)[0]).toContain("SELECT level, COUNT(*)::int AS count");
    expect(page.length).toBeLessThanOrEqual(before.length);
    const empty = await meter.during(() => loggingService.entry.search({ since: since(), sources: [`${source}-none`] }));
    expect(reads(empty)).toHaveLength(1);
  });
});
