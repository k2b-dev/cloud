import { beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { assertPrivateDatabase } from "../../test/private-database";
import { maintainShareAccess, recordShareAccess, type ShareAccessClient } from "./share-access";
import { migrateShareAccess } from "./share-access-migration";

const suite = suiteFor("database");
const now = new Date("2030-05-15T12:34:56Z");
const hour = new Date("2030-05-15T12:00:00Z");
const day = 86_400_000;
const share = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const old = new Date(now.getTime() - 40 * day);
const record = (network: string, client: ShareAccessClient = "chrome", shareId = share, at = now) =>
  recordShareAccess(shareId, "page", { network, client }, { now: at });
const maintain = (retentionDays = 365) => maintainShareAccess({ now, retentionDays });
const totals = async () =>
  (
    await sql`SELECT coalesce(sum(pages),0)::int AS pages,coalesce(sum(downloads),0)::int AS downloads,
    coalesce(sum(password_failed),0)::int AS password_failed FROM filesv2.share_access`
  )[0];

suite("Files public share access accounting with private Postgres", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA IF NOT EXISTS filesv2`.simple();
    await migrateShareAccess();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.share_access,filesv2.share_access_daily`;
  });

  test("migration is idempotent under concurrent startup and daily rows contain no network or client", async () => {
    await record("192.0.2.231");
    await Promise.all([migrateShareAccess(), migrateShareAccess()]);
    expect(await totals()).toEqual({ pages: 1, downloads: 0, password_failed: 0 });
    const columns = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
      WHERE table_schema='filesv2' AND table_name='share_access_daily' ORDER BY ordinal_position`;
    expect(columns.map((row) => row.column_name)).toEqual(["share_id", "day", "pages", "downloads", "password_failed"]);
  });

  test("all events increment only their counter; missing context is unknown; UTC hours and shares stay separate", async () => {
    await record("192.0.2.231");
    await recordShareAccess(share, "download", { network: "::ffff:192.0.2.232", client: "chrome" }, { now });
    await recordShareAccess(share, "password_failed", { network: "192.0.2.0/24", client: "chrome" }, { now });
    await recordShareAccess(share, "page", undefined, { now });
    await record("192.0.2.231", "chrome", other);
    await record("192.0.2.231", "chrome", share, new Date("2030-05-15T13:00:00Z"));
    const rows = await sql`SELECT hour,network,client,pages::int,downloads::int,password_failed::int
      FROM filesv2.share_access WHERE share_id=${share}::uuid ORDER BY hour,network`;
    expect([...rows]).toEqual([
      { hour, network: "192.0.2.0/24", client: "chrome", pages: 1, downloads: 1, password_failed: 1 },
      { hour, network: "unknown", client: "unknown", pages: 1, downloads: 0, password_failed: 0 },
      { hour: new Date("2030-05-15T13:00:00Z"), network: "192.0.2.0/24", client: "chrome", pages: 1, downloads: 0, password_failed: 0 },
    ]);
    expect(await totals()).toEqual({ pages: 4, downloads: 1, password_failed: 1 });
  });

  test("concurrent increments lose no events", async () => {
    await Promise.all(Array.from({ length: 120 }, () => record("192.0.2.231")));
    expect(await totals()).toEqual({ pages: 120, downloads: 0, password_failed: 0 });
    expect((await sql`SELECT * FROM filesv2.share_access`).length).toBe(1);
  });

  test("100 DISTINCT networks across clients is strict under concurrency; overflow preserves known networks", async () => {
    await sql`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages)
      SELECT ${share}::uuid,${hour},'10.0.'||g||'.0/24',client,1
      FROM generate_series(0,98) g CROSS JOIN (VALUES('chrome'),('firefox')) c(client)`;
    const clients = ["firefox", "edge", "safari", "opera"] as const;
    // Alternate UUID spelling must still use the same lock.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        record(`10.1.${i}.231`, clients[i % clients.length]!, i % 2 ? share.replaceAll("-", "") : share),
      ),
    );
    const [counts] = await sql`SELECT count(DISTINCT network) FILTER(WHERE network<>'*')::int AS networks,
      coalesce(sum(pages) FILTER(WHERE network='*'),0)::int AS overflow FROM filesv2.share_access`;
    expect(counts).toEqual({ networks: 100, overflow: 39 });
    await record("10.0.0.232", "samsung");
    await record("10.0.0.233", "samsung");
    const [known] = await sql`SELECT pages::int FROM filesv2.share_access WHERE network='10.0.0.0/24' AND client='samsung'`;
    expect(known).toEqual({ pages: 2 });
    expect(await totals()).toEqual({ pages: 240, downloads: 0, password_failed: 0 });
    await record("203.0.113.231", "chrome", other);
    await record("203.0.113.231", "chrome", share, new Date("2030-05-15T13:00:00Z"));
    expect((await sql`SELECT network FROM filesv2.share_access WHERE network='203.0.113.0/24'`).length).toBe(2);
  });

  test("data boundary and SQL constraints prevent raw addresses and raw user agents", async () => {
    await record("full invalid address or secret user agent");
    await record("2001:db8:abcd:1234::9");
    const rows = await sql`SELECT network,client FROM filesv2.share_access ORDER BY network`;
    expect([...rows]).toEqual([
      { network: "2001:db8:abcd::/48", client: "chrome" },
      { network: "unknown", client: "chrome" },
    ]);
    for (const network of ["192.0.2.231", "2001:db8:abcd:1234::9", "192.0.2.231/24"])
      await expect(
        sql`INSERT INTO filesv2.share_access(share_id,hour,network,client) VALUES(${other}::uuid,${hour},${network},'chrome')`.execute(),
      ).rejects.toThrow();
    await expect(
      sql`INSERT INTO filesv2.share_access(share_id,hour,network,client)
      VALUES(${other}::uuid,${hour},'unknown','Mozilla/5.0 raw user agent')`.execute(),
    ).rejects.toThrow();
  });

  test("a failed record rolls back its counter and releases the cap lock", async () => {
    await sql`CREATE FUNCTION filesv2.reject_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'record refused'; END $$`.simple();
    await sql`CREATE TRIGGER reject_access BEFORE INSERT ON filesv2.share_access FOR EACH ROW EXECUTE FUNCTION filesv2.reject_access()`.simple();
    try {
      await expect(record("192.0.2.231")).rejects.toThrow("record refused");
      expect(await totals()).toEqual({ pages: 0, downloads: 0, password_failed: 0 });
    } finally {
      await sql`DROP TRIGGER reject_access ON filesv2.share_access`.simple();
      await sql`DROP FUNCTION filesv2.reject_access()`.simple();
    }
    await record("192.0.2.231");
    expect(await totals()).toEqual({ pages: 1, downloads: 0, password_failed: 0 });
  });

  test("rollup adds every network, client and hour to UTC days exactly once, retaining the 30-day boundary", async () => {
    const start = new Date("2030-04-01T23:30:00-02:00");
    await record("192.0.2.231", "chrome", share, start);
    await record("198.51.100.231", "firefox", share, new Date("2030-04-02T02:00:00Z"));
    await recordShareAccess(share, "download", undefined, { now: start });
    await recordShareAccess(share, "password_failed", undefined, { now: start });
    await sql`INSERT INTO filesv2.share_access_daily VALUES(${share}::uuid,'2030-04-02',3,4,5)`;
    await record("203.0.113.231", "chrome", share, new Date("2030-04-15T13:00:00Z"));
    // Exact cutoff hour is retained (the fixture clock here is on the hour).
    await record("203.0.113.231", "chrome", share, new Date("2030-04-15T12:00:00Z"));
    expect(await maintainShareAccess({ now: hour, retentionDays: 365 })).toEqual({ rolledUp: 3, purged: 0 });
    const [daily] = await sql`SELECT day::text,pages::int,downloads::int,password_failed::int FROM filesv2.share_access_daily`;
    expect(daily).toEqual({ day: "2030-04-02", pages: 5, downloads: 5, password_failed: 6 });
    expect(await maintainShareAccess({ now: hour, retentionDays: 365 })).toEqual({ rolledUp: 0, purged: 0 });
    expect(await totals()).toEqual({ pages: 2, downloads: 0, password_failed: 0 });
  });

  test("rollup and daily retention are one transaction: retention failure restores hourly rows and daily totals", async () => {
    await record("192.0.2.231", "chrome", share, old);
    await sql`INSERT INTO filesv2.share_access_daily VALUES(${other}::uuid,'2028-01-01',7,8,9)`;
    await sql`CREATE FUNCTION filesv2.reject_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention refused'; END $$`.simple();
    await sql`CREATE TRIGGER reject_retention BEFORE DELETE ON filesv2.share_access_daily FOR EACH ROW EXECUTE FUNCTION filesv2.reject_retention()`.simple();
    try {
      await expect(maintain()).rejects.toThrow("retention refused");
      expect(await totals()).toEqual({ pages: 1, downloads: 0, password_failed: 0 });
      expect([...(await sql`SELECT share_id,pages::int FROM filesv2.share_access_daily`)]).toEqual([{ share_id: other, pages: 7 }]);
    } finally {
      await sql`DROP TRIGGER reject_retention ON filesv2.share_access_daily`.simple();
      await sql`DROP FUNCTION filesv2.reject_retention()`.simple();
    }
    expect(await maintain()).toEqual({ rolledUp: 1, purged: 1 });
  });

  test("daily insert failure never deletes its hourly source", async () => {
    await record("192.0.2.231", "chrome", share, old);
    await sql`ALTER TABLE filesv2.share_access_daily ADD CONSTRAINT test_reject_daily CHECK(pages=0)`.simple();
    try {
      await expect(maintain()).rejects.toThrow();
      expect(await totals()).toEqual({ pages: 1, downloads: 0, password_failed: 0 });
      expect([...(await sql`SELECT * FROM filesv2.share_access_daily`)]).toEqual([]);
    } finally {
      await sql`ALTER TABLE filesv2.share_access_daily DROP CONSTRAINT test_reject_daily`.simple();
    }
  });

  test("concurrent maintenance workers preserve exact sums and cannot double-roll a row", async () => {
    await sql`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages,downloads,password_failed)
      SELECT ${share}::uuid,date_trunc('hour',${old}::timestamptz),'10.0.'||g||'.0/24','chrome',1,2,3 FROM generate_series(0,99) g`;
    const results = await Promise.all(Array.from({ length: 4 }, () => maintain()));
    expect(results.reduce((count, result) => count + result.rolledUp, 0)).toBe(100);
    expect(await totals()).toEqual({ pages: 0, downloads: 0, password_failed: 0 });
    expect([...(await sql`SELECT pages::int,downloads::int,password_failed::int FROM filesv2.share_access_daily`)]).toEqual([
      { pages: 100, downloads: 200, password_failed: 300 },
    ]);
  });

  test("a worker skips another maintenance owner without waiting and can retry", async () => {
    await record("192.0.2.231", "chrome", share, old);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('filesv2.share-access-maintenance',0))`;
      locked.resolve();
      await release.promise;
    });
    void owner.catch(locked.reject);
    try {
      await locked.promise;
      expect(await maintain()).toEqual({ rolledUp: 0, purged: 0 });
    } finally {
      release.resolve();
      await owner;
    }
    expect(await maintain()).toEqual({ rolledUp: 1, purged: 0 });
  });

  test("retention keeps its boundary day in UTC, purges older days and rejects invalid policy", async () => {
    await sql`INSERT INTO filesv2.share_access_daily VALUES
      (${share}::uuid,'2030-04-14',1,2,3),(${share}::uuid,'2030-04-15',4,5,6),(${share}::uuid,'2030-04-16',7,8,9)`;
    expect(await maintain(30)).toEqual({ rolledUp: 0, purged: 1 });
    expect((await sql<{ day: string }[]>`SELECT day::text FROM filesv2.share_access_daily ORDER BY day`).map((row) => row.day)).toEqual([
      "2030-04-15",
      "2030-04-16",
    ]);
    for (const retentionDays of [0, 29, 3651, 30.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(maintain(retentionDays)).rejects.toThrow(RangeError);
    expect(await maintain(3650)).toEqual({ rolledUp: 0, purged: 0 });
  });

  test("one maintenance call processes at most 10000 source rows even when both tables have a backlog", async () => {
    await sql`INSERT INTO filesv2.share_access(share_id,hour,network,client,pages)
      SELECT md5(g::text)::uuid,date_trunc('hour',${old}::timestamptz),'192.0.2.0/24','chrome',1 FROM generate_series(1,10001) g`;
    await sql`INSERT INTO filesv2.share_access_daily(share_id,day,pages)
      SELECT md5(g::text)::uuid,'2028-01-01'::date,1 FROM generate_series(1,10001) g`;
    expect(await maintain()).toEqual({ rolledUp: 10000, purged: 0 });
    expect((await sql`SELECT count(*)::int AS n FROM filesv2.share_access`)[0]!.n).toBe(1);
    expect(await maintain()).toEqual({ rolledUp: 1, purged: 9999 });
    expect(await maintain()).toEqual({ rolledUp: 0, purged: 2 });
    expect((await sql`SELECT sum(pages)::int AS pages FROM filesv2.share_access_daily`)[0]!.pages).toBe(10001);
  });
});
