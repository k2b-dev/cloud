import { afterAll, beforeAll, expect, test } from "bun:test";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";

// A private migrated database: the counts below are about this log alone, not the entries other suites write.
const database = testInfra.database ? await useMigratedDatabase("audit_list") : null;
afterAll(async () => {
  await database?.drop();
}, 60_000);
const { AUDIT_COUNT_BOUND, audit } = await import("./index");

const AUTOMATIC = `'{"provenance":"system","service":"app-workload"}'::jsonb`;
/** The plan of a statement as JSON, and the names of the indexes it reads. */
const indexesOf = async (statement: string) => {
  const [row] = await sql.unsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (FORMAT JSON) ${statement}`);
  const plan = JSON.stringify(row!["QUERY PLAN"]);
  const names = [...plan.matchAll(/"Index Name":"([^"]+)"/g)].map((match) => match[1]);
  // a plan without the expected index names its nodes, so a failure shows what the planner chose instead
  return names.length > 0 ? names : [plan.slice(0, 400)];
};
const VISIBLE = "NOT ((metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE)";

databaseSuite()("the visible audit log (integration)", () => {
  beforeAll(async () => {
    // 60,000 entries over the last year, every second one written by an app's runtime key, as a busy installation that
    // keeps its log has them (the last 30 days are a twelfth of it); and five entries in the same microsecond, where a
    // page can end between them.
    await sql.unsafe(`
      INSERT INTO audit.events (created_at, action, outcome, actor_uid, metadata)
      SELECT now() - (n * interval '525 seconds'), 'test.event', 'allowed', 'u' || n,
        CASE WHEN n % 2 = 0 THEN ${AUTOMATIC} ELSE '{}'::jsonb END
      FROM generate_series(1, 60000) AS n
    `);
    await sql`INSERT INTO audit.events (created_at, action, outcome, actor_uid)
      SELECT timestamptz '2026-11-01 10:00:00.123456+00', 'test.tie', 'allowed', 'tie' || n FROM generate_series(1, 5) AS n`;
    await sql`ANALYZE audit.events`;
  });

  test("the migration builds the partial index of the visible log, valid, and running it again keeps that one", async () => {
    const { migrate } = await import("../../../../core/src/migrate/core/audit");
    await migrate();
    await migrate();
    const rows = await sql<{ name: string; valid: boolean; definition: string }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(c.oid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'audit.events'::regclass AND c.relname LIKE 'idx_audit_events_%_created'
      ORDER BY c.relname`;
    expect(rows.map(({ name, valid }) => ({ name, valid }))).toEqual([{ name: "idx_audit_events_visible_created", valid: true }]);
  });

  test("a bounded count stops at its bound and says so; the newest visible entries read through their own index", async () => {
    const page = await audit.list({ filter: { automatic: "hide", days: 30 }, count: "bounded", pagination: { perPage: 50 } });
    expect({ total: page.total, hidden: page.hiddenAutomaticCount, lowerBound: page.countIsLowerBound }).toEqual({
      total: AUDIT_COUNT_BOUND,
      hidden: AUDIT_COUNT_BOUND,
      lowerBound: true,
    });
    expect(page.items).toHaveLength(50);
    // the exact count of the same filter, for comparison: the default stays exact
    const exact = await audit.list({ filter: { automatic: "hide", days: 30 }, pagination: { perPage: 50 } });
    // counted directly, as the reference for the exact mode
    const [direct] = await sql<{ visible: number; automatic: number }[]>`
      SELECT COUNT(*) FILTER (WHERE NOT ((metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE))::int AS visible,
        COUNT(*) FILTER (WHERE (metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE)::int AS automatic
      FROM audit.events WHERE created_at >= now() - interval '30 days'`;
    expect(direct!.visible).toBeGreaterThan(AUDIT_COUNT_BOUND);
    expect({ total: exact.total, hidden: exact.hiddenAutomaticCount }).toEqual({ total: direct!.visible, hidden: direct!.automatic });
    expect(exact.countIsLowerBound).toBeUndefined();
    // a narrow filter counts exactly in bounded mode too
    const ties = await audit.list({ filter: { automatic: "hide", action: "test.tie" }, count: "bounded" });
    expect({ total: ties.total, lowerBound: ties.countIsLowerBound }).toEqual({ total: 5, lowerBound: false });

    // the newest visible entries, as `latest` and an unfiltered first page ask for them, read only themselves
    expect(await indexesOf(`SELECT * FROM audit.events WHERE ${VISIBLE} ORDER BY created_at DESC, id DESC LIMIT 51`)).toEqual([
      "idx_audit_events_visible_created",
    ]);
  });

  test("a cursor pages the visible log without gaps or repeats, also between entries of the same microsecond", async () => {
    const filter = { automatic: "hide" as const };
    // the same entries by number, as the reference
    const reference = (await audit.list({ filter, pagination: { page: 1, perPage: 100 } })).items.map((event) => event.id);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 4; step++) {
      const page = await audit.list({ filter, cursor, count: "bounded", pagination: { perPage: 25 } });
      seen.push(...page.items.map((event) => event.id));
      expect(page.hasNext).toBe(true);
      cursor = page.nextCursor ?? null;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(reference);

    // five entries share one microsecond; pages of two end between them and still list each once
    const ties: number[] = [];
    let next: string | null = null;
    for (;;) {
      const page = await audit.list({ filter: { automatic: "hide", action: "test.tie" }, cursor: next, pagination: { perPage: 2 } });
      ties.push(...page.items.map((event) => event.id));
      next = page.nextCursor ?? null;
      if (!next) break;
    }
    expect(ties).toHaveLength(5);
    expect(new Set(ties).size).toBe(5);
    expect(ties).toEqual([...ties].sort((a, b) => b - a));

    // a cursor the service did not write lists from the newest entry instead of failing
    const garbled = await audit.list({ filter, cursor: "not-a-cursor", pagination: { perPage: 3 } });
    expect(garbled.items.map((event) => event.id)).toEqual(reference.slice(0, 3));
  });

  test("a page of the log costs two statements in every mode", async () => {
    const meter = await meterSql();
    try {
      for (const options of [{}, { count: "bounded" as const }, { cursor: null, count: "bounded" as const }]) {
        const statements = await meter.during(() =>
          audit.list({ filter: { automatic: "hide", days: 30 }, pagination: { perPage: 50 }, ...options }),
        );
        expect({ options, statements: statements.length }).toEqual({ options, statements: 2 });
      }
    } finally {
      await meter.close();
    }
  });
});
