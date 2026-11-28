import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

// A recording database: CI has no TimescaleDB, so this file pins the statements the helper sends for a hypertable, in
// their order, with a catalog that answers as the real one does. The hypertable integration test runs them for real.
const statements: string[] = [];
let catalog = { present: false, valid: false, building: false, timescale: true };
let hypertable = true;
/** The error a statement meets, as Postgres reports it to Bun; none by default. */
let failing: (statement: string) => Error | undefined = () => undefined;
const sqlError = (errno: string) => Object.assign(new Error(`postgres error ${errno}`), { errno });

const run = async (statement: string) => {
  statements.push(statement);
  const error = failing(statement);
  if (error) throw error;
  if (statement.startsWith("CREATE INDEX")) catalog = { ...catalog, present: true, valid: true };
  if (statement.startsWith("DROP INDEX")) catalog = { ...catalog, present: false, valid: false };
  return [];
};
const query = async (strings: TemplateStringsArray) => {
  const text = strings.join("$");
  if (text.includes("timescaledb_information.hypertables")) return [{ yes: hypertable }];
  if (text.includes("AS present")) return [{ ...catalog }];
  throw new Error(`unexpected query: ${text}`);
};
const fakeSql = Object.assign(query, {
  unsafe: (statement: string) => ({ simple: () => run(statement) }),
  reserve: async () => fakeSql,
  release: () => {},
});
const clients = await import("../runtime/clients");
mock.module("../runtime/clients", () => ({ ...clients, sql: fakeSql }));

const { ensureConcurrentIndexes } = await import("./concurrent-index");
const { logger } = await import("./logging");

const log = logger("concurrent-index-hypertable-unit-test");
const options = { log, purpose: "test" };
const VISIBLE = { name: "events_visible", table: "hyper.events", definition: "(created_at DESC, id DESC)", where: "NOT flagged" };
const SET = "SET lock_timeout = '1s'";
const RESET = "RESET lock_timeout";
const CREATE =
  "CREATE INDEX IF NOT EXISTS events_visible ON hyper.events (created_at DESC, id DESC) WITH (timescaledb.transaction_per_chunk) WHERE NOT flagged";
const DROP = "DROP INDEX CONCURRENTLY IF EXISTS hyper.events_visible";
const quiet: { mockRestore: () => void }[] = [];

beforeEach(() => {
  statements.length = 0;
  catalog = { present: false, valid: false, building: false, timescale: true };
  hypertable = true;
  failing = () => undefined;
  quiet.push(
    spyOn(log, "info").mockImplementation(() => {}),
    spyOn(log, "warn").mockImplementation(() => {}),
  );
});
afterEach(() => {
  for (const spy of quiet.splice(0)) spy.mockRestore();
});

test("a hypertable build names its options before its predicate and runs between SET and RESET of the lock timeout", async () => {
  expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("built");
  expect(statements).toEqual([SET, CREATE, RESET]);
  expect(CREATE.indexOf("WITH (")).toBeLessThan(CREATE.indexOf(" WHERE "));
});

test("a build that meets the lock timeout resets it, drops its half-built index under the timeout too, and is busy", async () => {
  failing = (statement) => {
    if (statement !== CREATE) return undefined;
    catalog = { ...catalog, present: true, valid: false };
    return sqlError("55P03");
  };
  expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("busy");
  expect(statements).toEqual([SET, CREATE, RESET, SET, DROP, RESET]);
});

test("a leftover drop that meets a lock or a deadlock resets the timeout, is busy, and builds nothing", async () => {
  for (const errno of ["55P03", "40P01"]) {
    statements.length = 0;
    catalog = { ...catalog, present: true, valid: false };
    failing = (statement) => (statement === DROP ? sqlError(errno) : undefined);
    expect({ errno, outcome: await ensureConcurrentIndexes([VISIBLE], options) }).toEqual({ errno, outcome: "busy" });
    expect(statements).toEqual([SET, DROP, RESET]);
  }
});

test("a failed build whose leftover drop meets a lock is busy, not failed", async () => {
  failing = (statement) => {
    if (statement === CREATE) {
      catalog = { ...catalog, present: true, valid: false };
      return sqlError("XX000");
    }
    return statement === DROP ? sqlError("55P03") : undefined;
  };
  expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("busy");
  expect(statements).toEqual([SET, CREATE, RESET, SET, DROP, RESET]);
});

test("a plain table is built CONCURRENTLY and never touches the lock timeout", async () => {
  hypertable = false;
  catalog = { ...catalog, present: true, valid: false };
  expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("built");
  expect(statements).toEqual([
    DROP,
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS events_visible ON hyper.events (created_at DESC, id DESC) WHERE NOT flagged",
  ]);
});

test("a definition with a comment, or with its own WHERE next to `where`, is refused before any statement", async () => {
  for (const index of [
    { ...VISIBLE, definition: "(created_at) -- rest" },
    { ...VISIBLE, definition: "(created_at) /* rest */" },
    { ...VISIBLE, where: "flagged -- rest" },
    { ...VISIBLE, definition: "(created_at) WHERE id > 0" },
  ]) {
    expect({ index, outcome: await ensureConcurrentIndexes([index], options) }).toEqual({ index, outcome: "failed" });
  }
  expect(statements).toEqual([]);
});
