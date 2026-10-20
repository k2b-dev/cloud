import { deniedReadQueries, deniedReadCodes } from "./read-attacks.test-fixture";
import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery as admin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { READ_PROFILE_NAMES } from "./admin-contracts";
import { READ_VIEWS } from "./base-schema";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { clickhouseQuery, type QueryOptions, StoreQueryError } from "./client";
import { READ_LIMITS, READ_PROFILES } from "./setup-sql";
import { quoteIdentifier as q } from "./validation";

const suite = suiteFor("database", "clickhouse");
/** A transport failure is never evidence of an authorization boundary. */
const refused = async (run: () => Promise<unknown>, codes: readonly number[], attack = "attack") => {
  let code: number | undefined;
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreQueryError && error.kind === "clickhouse") code = error.code;
    else throw error;
  }
  // Name the attack: a passing attack is the finding, and the failure must say which one.
  if (code === undefined) throw new Error(`Attack was not refused: ${attack}`);
  if (!codes.includes(code)) throw new Error(`Attack refused with ${code}, expected ${codes.join(" or ")}: ${attack}`);
};
suite("Pulse read users hold the tenant boundary over HTTP", () => {
  beforeAll(installFixtureStore, 30_000);
  test("every profile and both bases reject the complete attack matrix; widening one grant breaks the negative control", async () => {
    const bases = [await fixtureBase(), await fixtureBase()],
      store = fixtureStore();
    // Using a named collection needs a NAMED COLLECTION grant on its name, whether or not it exists; the fixture
    // admin cannot create one (named_collection_control is off by default), so the attack names one that may exist.
    const collection = `${bases[0]!.database}_collection`;
    try {
      for (const base of bases) {
        await createBaseLifecycle(store)(base.id);
        await store.query(
          `INSERT INTO ${q(base.database)}._events(id,ts,kind,sensitive,payload,version) VALUES(generateUUIDv4(),now64(3),{marker:String},'private field','private payload',1)`,
          { marker: base.id },
        );
        await store.query(
          `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version) VALUES(generateUUIDv4(),generateUUIDv4(),now64(3),42,1)`,
        );
      }
      for (const profile of READ_PROFILE_NAMES)
        for (const [index, base] of bases.entries()) {
          await sql`UPDATE pulse.base_stores SET profile=${profile},reconcile_needed=true WHERE base_id=${base.id}::uuid`;
          await createBaseLifecycle(store)(base.id);
          const credentials = await store.readUserCredentials(base.id),
            own = q(base.database),
            other = q(bases[1 - index]!.database);
          // Twice the profile's 4 MiB result limit, so ClickHouse's own refusal is what the limit attacks observe.
          const run = (query: string, settings?: QueryOptions["settings"], timeoutMs = 45_000) =>
            clickhouseQuery({ ...fixtureConnection(), ...credentials, query, settings, timeoutMs, maxResponseBytes: 8 * 1024 * 1024 });
          const grants = await admin(
            "SELECT access_type,database,table,grant_option,is_partial_revoke FROM system.grants WHERE user_name={user:String} ORDER BY table",
            { params: { user: base.readUser } },
          );
          expect(
            grants.map((g) => ({
              type: g.access_type,
              database: g.database,
              table: g.table,
              grant: Number(g.grant_option),
              revoke: Number(g.is_partial_revoke),
            })),
          ).toEqual([...READ_VIEWS].sort().map((table) => ({ type: "SELECT", database: base.database, table, grant: 0, revoke: 0 })));
          for (const view of READ_VIEWS) {
            const args = ["increase", "rate", "histogram_quantile"].includes(view)
              ? `(metric='fixture',from=toDateTime64('2026-10-17 00:00:00',3),to=toDateTime64('2026-10-18 00:00:00',3)${view === "histogram_quantile" ? ",quantile=0.95" : ""})`
              : "";
            await run(`SELECT * FROM ${own}.${q(view)}${args} LIMIT 1`);
          }
          const [marker] = await run(`SELECT kind FROM ${own}.events`);
          expect(marker?.kind).toBe(base.id);
          const [settings] = await run("SELECT getSetting('max_memory_usage') AS memory, getSetting('max_execution_time') AS time");
          expect(Number(settings?.memory)).toBe(READ_PROFILES[`read_${profile}`].max_memory_usage);
          const denied = deniedReadQueries(base, bases[1 - index]!);
          for (const attack of denied) await refused(() => run(attack), deniedReadCodes(attack), attack);
          for (const column of ["sensitive", "payload"]) {
            await refused(() => run(`SELECT ${column} FROM ${own}.events`), [47, 497]);
            await refused(() => run(`SELECT ${column} FROM ${own}._events`), [497]);
          }
          // merge() reads only tables the user may read: the own views, never underscore tables or another base.
          await refused(() => run(`SELECT * FROM merge('${bases[1 - index]!.database}','.*')`), [636, 497], "merge other base");
          await refused(() => run(`SELECT * FROM merge('${base.database}','^_')`), [636, 497], "merge own tables");
          await refused(() => run(`SELECT sensitive FROM merge('${base.database}','.*')`), [47], "merge sensitive");
          const star = await run(`SELECT * FROM ${own}.events`);
          expect(star.every((row) => !("sensitive" in row) && !("payload" in row))).toBe(true);
          await refused(() => run("SELECT * FROM file('/etc/passwd',LineAsString)"), [291, 497]);
          await refused(() => run(`SHOW CREATE TABLE ${own}._events`), [497]);
          await refused(() => run("SELECT dictGet('missing_dictionary','value',toUInt64(1))"), [36, 497]);
          await refused(() => run("SELECT 1 FROM input('value UInt8')"), [477, 497]);
          await refused(() => run("SELECT repeat('x',2000000000)"), [131, 241]);
          await refused(() => run("SELECT sleepEachRow(1) FROM numbers(30)"), [160]);
          // Local, bounded generators are deliberately usable; they do not read another tenant or network.
          expect((await run("SELECT * FROM generateRandom('value UInt8') LIMIT 1")).length).toBe(1);
          expect(Number((await run("SELECT count() AS n FROM numbers(1000)"))[0]?.n)).toBe(1000);
          await run(`SELECT max(value) FROM ${own}.samples`);

          for (const query of [
            "SET max_memory_usage=1",
            "SELECT 1 SETTINGS max_memory_usage=1",
            "SELECT 1 SETTINGS readonly=0",
            "SELECT 1 SETTINGS max_execution_time=0",
            "SELECT 1 SETTINGS max_result_rows=1000000",
            "SELECT 1 SETTINGS use_query_cache=1",
          ])
            await refused(() => run(query), [164, 497]);
          await refused(() => run("SELECT 1", { max_memory_usage: 1 }), [164]);
          await refused(() => run("SELECT 1", { use_query_cache: 1 }), [164, 497]);
          await refused(() => run(`SELECT 1; DROP TABLE ${own}._events`), [62]);
          for (const system of ["tables", "columns"]) {
            const foreign = await run(
              `SELECT database FROM system.${system} WHERE database={foreign:String}`.replace(
                "{foreign:String}",
                `'${bases[1 - index]!.database}'`,
              ),
            );
            expect(foreign).toEqual([]);
            const metadata = await run(
              `SELECT DISTINCT ${system === "tables" ? "name" : "table"} AS table_name FROM system.${system} WHERE database='${base.database}'`,
            );
            expect(metadata.map((r) => r.table_name).sort()).toEqual([...READ_VIEWS].sort());
          }
          await refused(() => run("SELECT number FROM numbers(10001)", { wait_end_of_query: 1 }), [396]);
          await refused(() => run("SELECT materialize(repeat('x',5000)) FROM numbers(1000)", { wait_end_of_query: 1 }), [396]);
          // Finding (ClickHouse 26.9): max_result_bytes does not count a constant column per row, so
          // `repeat('x',100000) FROM numbers(10000)` streams 1 GB past the 4 MiB limit. The guard is Pulse's own
          // response cap; a read path must never lift it above the profile's answer size.
          let capped = false;
          await clickhouseQuery({
            ...fixtureConnection(),
            ...credentials,
            query: "SELECT repeat('x',5000) FROM numbers(1000)",
            timeoutMs: 45_000,
            maxResponseBytes: READ_LIMITS.max_result_bytes,
          }).catch((error: unknown) => {
            capped = error instanceof StoreQueryError && error.kind === "unreachable";
          });
          expect(capped).toBe(true);
          await refused(() => run("SELECT sum(cityHash64(number)) FROM numbers(200000001)"), [158]);
          await refused(() => run("SELECT groupArray(repeat(toString(number),100)) FROM numbers(10000000)", undefined, 45_000), [241]);
          if (index === 0) {
            const start = performance.now();
            await refused(
              () =>
                run("SELECT sum(cityHash64(a.number,b.number)) FROM numbers(1000000) a CROSS JOIN numbers(1000000) b", undefined, 45_000),
              [159],
            );
            // Keep this assertion strict: a ClickHouse wall-clock failure is an open finding, never silently loosen it.
            expect(performance.now() - start).toBeLessThan((READ_PROFILES[`read_${profile}`].max_execution_time + 5) * 1000);
          }
          await run(`SELECT count() FROM ${own}.events`);
        }
      const base = bases[0]!,
        credentials = await store.readUserCredentials(base.id);
      const attack = () =>
        clickhouseQuery({
          ...fixtureConnection(),
          ...credentials,
          query: `SELECT sensitive FROM ${q(base.database)}._events`,
          timeoutMs: 5000,
        });
      await refused(attack, [497]);
      await admin(`GRANT SELECT ON ${q(base.database)}._events TO ${q(base.readUser)}`);
      try {
        expect((await attack()).length).toBe(1);
      } finally {
        await admin(`REVOKE SELECT ON ${q(base.database)}._events FROM ${q(base.readUser)}`);
      }
      await refused(attack, [497]);
    } finally {
      for (const base of bases) await cleanupFixtureBase(base);
    }
  }, 360_000);
});
