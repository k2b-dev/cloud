import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";

// A private migrated database: the counts below are about this log alone, not the entries other suites write.
const database = testInfra.database ? await useMigratedDatabase("audit_list") : null;
afterAll(async () => {
  await database?.drop();
}, 60_000);
const { AUDIT_COUNT_BOUND, AuditCursorError, audit, auditListStatements } = await import("./index");
const { migrate } = await import("../../../../core/src/migrate/core/audit");
const { settleBackgroundIndexBuilds } = await import("../concurrent-index");
/** The migration, and the index build it starts in the background, as a start that runs until the build ends. */
const migrateAndBuild = async () => {
  await migrate();
  expect(await settleBackgroundIndexBuilds()).toBe(true);
};

const AUTOMATIC = `'{"provenance":"system","service":"app-workload"}'::jsonb`;
const INDEX = "idx_audit_events_visible_created";
/**
 * The names of the indexes a statement of the service reads, as the planner chooses for it. Where TimescaleDB made the
 * log a hypertable, each chunk is read through its own copy of the index (`_hyper_1_2_chunk_<name>`); those count as it.
 */
const indexesOf = async (statement: SQL.Query<unknown>) => {
  const [row] = await sql<{ "QUERY PLAN": unknown }[]>`EXPLAIN (FORMAT JSON) ${statement}`;
  const plan = JSON.stringify(row!["QUERY PLAN"]);
  const names = [...new Set([...plan.matchAll(/"Index Name":"(?:_hyper_\d+_\d+_chunk_)?([^"]+)"/g)].map((match) => match[1]))];
  // a plan without an index names its nodes, so a failure shows what the planner chose instead
  return names.length > 0 ? names : [plan.slice(0, 400)];
};
const visibleIndex = () => sql<{ valid: boolean }[]>`
  SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'audit.events'::regclass AND c.relname = ${INDEX}`;
/** Every page by cursor, as the ids it lists, from the first page to the last. */
const allByCursor = async (filter: Parameters<typeof audit.list>[0]["filter"], perPage: number) => {
  const seen: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await audit.list({ filter, cursor, pagination: { perPage } });
    seen.push(...page.items.map((event) => event.id));
    cursor = page.nextCursor ?? null;
    if (!cursor) return seen;
  }
};
/** The same entries by number, as the reference. */
const allByNumber = async (filter: Parameters<typeof audit.list>[0]["filter"]) =>
  (await audit.list({ filter, pagination: { page: 1, perPage: 100 } })).items.map((event) => event.id);

databaseSuite()("the visible audit log (integration)", () => {
  beforeAll(async () => {
    // 60,000 entries over the last year, every second one written by an app's runtime key, as a busy installation that
    // keeps its log has them (the last 30 days are a twelfth of it); five entries in the same microsecond, where a page
    // can end between them; and an action with 1,500 automatic entries but only three visible ones.
    await sql.unsafe(`
      INSERT INTO audit.events (created_at, action, outcome, actor_uid, metadata)
      SELECT now() - (n * interval '525 seconds'), 'test.event', 'allowed', 'u' || n,
        CASE WHEN n % 2 = 0 THEN ${AUTOMATIC} ELSE '{}'::jsonb END
      FROM generate_series(1, 60000) AS n
    `);
    await sql`INSERT INTO audit.events (created_at, action, outcome, actor_uid)
      SELECT timestamptz '2026-11-01 10:00:00.123456+00', 'test.tie', 'allowed', 'tie' || n FROM generate_series(1, 5) AS n`;
    await sql.unsafe(`
      INSERT INTO audit.events (created_at, action, outcome, actor_uid, metadata)
      SELECT now() - (n * interval '61 seconds'), 'test.mostly-automatic', 'allowed', 'm' || n,
        CASE WHEN n <= 3 THEN '{}'::jsonb ELSE ${AUTOMATIC} END
      FROM generate_series(1, 1503) AS n
    `);
    await sql`ANALYZE audit.events`;
  });

  test("the migration builds the partial index of the visible log, valid; again and twice at once keep that one", async () => {
    await migrateAndBuild();
    await Promise.all([migrateAndBuild(), migrateAndBuild()]);
    expect(await visibleIndex()).toEqual([{ valid: true }]);
  });

  test("an invalid index left by an interrupted build is built again", async () => {
    // what an interrupted build leaves: the index in the catalog, marked invalid
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'audit.${INDEX}'::regclass`);
    expect(await visibleIndex()).toEqual([{ valid: false }]);
    await migrateAndBuild();
    expect(await visibleIndex()).toEqual([{ valid: true }]);
  });

  test("a bounded count stops at its bound and says so for each side; the default stays exact", async () => {
    const page = await audit.list({ filter: { automatic: "hide", days: 30 }, count: "bounded", pagination: { perPage: 50 } });
    expect({
      total: page.total,
      hidden: page.hiddenAutomaticCount,
      lowerBound: page.countIsLowerBound,
      hiddenLowerBound: page.hiddenCountIsLowerBound,
    }).toEqual({ total: AUDIT_COUNT_BOUND, hidden: AUDIT_COUNT_BOUND, lowerBound: true, hiddenLowerBound: true });
    expect(page.items).toHaveLength(50);
    const exact = await audit.list({ filter: { automatic: "hide", days: 30 }, pagination: { perPage: 50 } });
    const [direct] = await sql<{ visible: number; automatic: number }[]>`
      SELECT COUNT(*) FILTER (WHERE NOT ((metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE))::int AS visible,
        COUNT(*) FILTER (WHERE (metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE)::int AS automatic
      FROM audit.events WHERE created_at >= now() - interval '30 days'`;
    expect(direct!.visible).toBeGreaterThan(AUDIT_COUNT_BOUND);
    expect({ total: exact.total, hidden: exact.hiddenAutomaticCount }).toEqual({ total: direct!.visible, hidden: direct!.automatic });
    expect(exact.countIsLowerBound).toBeUndefined();
    // few visible entries among many automatic ones: the visible count is exact, only the hidden one is a lower bound
    const mostly = await audit.list({ filter: { automatic: "hide", action: "test.mostly-automatic" }, count: "bounded" });
    expect({
      total: mostly.total,
      lowerBound: mostly.countIsLowerBound,
      hidden: mostly.hiddenAutomaticCount,
      hiddenLowerBound: mostly.hiddenCountIsLowerBound,
    }).toEqual({ total: 3, lowerBound: false, hidden: AUDIT_COUNT_BOUND, hiddenLowerBound: true });
  });

  test("numbered pages under a bounded count go on past the bound and end where the log ends", async () => {
    const filter = { automatic: "hide" as const, days: 30 };
    const perPage = 50;
    // the page at the bound: there is more, although the count stopped there
    const atBound = await audit.list({ filter, count: "bounded", pagination: { page: AUDIT_COUNT_BOUND / perPage, perPage } });
    expect({ items: atBound.items.length, hasNext: atBound.hasNext }).toEqual({ items: perPage, hasNext: true });
    // the last page by the exact count has no next page in bounded mode either
    const { total } = await audit.list({ filter, pagination: { perPage } });
    const lastPage = Math.ceil(total / perPage);
    const last = await audit.list({ filter, count: "bounded", pagination: { page: lastPage, perPage } });
    expect({ items: last.items.length, hasNext: last.hasNext }).toEqual({ items: total - (lastPage - 1) * perPage, hasNext: false });
  });

  test("a cursor pages without gaps or repeats, with a range, a search and between entries of the same microsecond", async () => {
    // the first hundred visible entries, by cursor in pages of 25, are the first numbered page of a hundred
    const filter = { automatic: "hide" as const };
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 4; step++) {
      const page = await audit.list({ filter, cursor, count: "bounded", pagination: { perPage: 25 } });
      seen.push(...page.items.map((event) => event.id));
      cursor = page.nextCursor ?? null;
    }
    expect(seen).toEqual(await allByNumber(filter));
    // a range and a search page the same way; both match fewer than a hundred entries
    for (const narrowed of [
      { automatic: "hide" as const, days: 1 },
      { automatic: "hide" as const, search: "u1999" },
    ]) {
      const byNumber = await allByNumber(narrowed);
      expect(byNumber.length).toBeLessThan(100);
      expect({ narrowed, ids: await allByCursor(narrowed, 7) }).toEqual({ narrowed, ids: byNumber });
    }
    // five entries share one microsecond; pages of two end between them and still list each once
    const ties = await allByCursor({ automatic: "hide", action: "test.tie" }, 2);
    expect(ties).toHaveLength(5);
    expect(new Set(ties).size).toBe(5);
    expect(ties).toEqual([...ties].sort((a, b) => b - a));
  });

  test("a cursor the service did not write is refused, and the most distant valid one still reads", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of ["not-a-cursor", encode(["2026-11-01", 1]), encode([1.5, 2]), encode([1, 2, 3]), encode({})])
      await expect(audit.list({ filter: { automatic: "hide" }, cursor })).rejects.toBeInstanceOf(AuditCursorError);
    // the largest and smallest times a cursor can carry stay times Postgres reads, never an error of the database
    for (const micros of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      const page = await audit.list({ filter: { automatic: "hide" }, cursor: encode([micros, 1]), pagination: { perPage: 1 } });
      expect(page.items.length).toBeLessThanOrEqual(1);
    }
  });

  test("the service's own statements read the visible entries through their index where the planner can", async () => {
    // the newest visible entries, as an unfiltered first page and `latest` ask for them
    expect(await indexesOf(auditListStatements({ filter: { automatic: "hide" }, cursor: null, pagination: { perPage: 50 } }).rows)).toEqual(
      [INDEX],
    );
    const first = await audit.list({ filter: { automatic: "hide" }, cursor: null, pagination: { perPage: 50 } });
    expect(
      await indexesOf(auditListStatements({ filter: { automatic: "hide" }, cursor: first.nextCursor, pagination: { perPage: 50 } }).rows),
    ).toEqual([INDEX]);
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
