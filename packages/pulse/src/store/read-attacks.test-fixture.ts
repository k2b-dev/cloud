import { READ_VIEWS } from "./base-schema";
import { quoteIdentifier as q } from "./validation";
export const readViewArguments = (view: string) =>
  ["increase", "rate", "histogram_quantile"].includes(view)
    ? `(metric='fixture',from=toDateTime64('2026-10-17 00:00:00',3),to=toDateTime64('2026-10-18 00:00:00',3)${view === "histogram_quantile" ? ",quantile=0.95" : ""})`
    : "";
/** Same denied targets at the direct read-user, REST and capability seams. */
export const deniedReadQueries = (base: { database: string; readUser: string }, foreign: { database: string }) => {
  const own = q(base.database),
    other = q(foreign.database),
    collection = `${base.database}_collection`;
  return [
    `SELECT sensitive FROM ${own}.events`,
    `SELECT payload FROM ${own}.events`,
    `SELECT * FROM merge('${foreign.database}','.*')`,
    `SELECT * FROM merge('${base.database}','^_')`,
    `SELECT sensitive FROM merge('${base.database}','.*')`,
    "SELECT * FROM file('/etc/passwd',LineAsString)",
    `SHOW CREATE TABLE ${own}._events`,
    "SELECT dictGet('missing_dictionary','value',toUInt64(1))",
    "SELECT 1 FROM input('value UInt8')",
    ...READ_VIEWS.map((view) => `SELECT * FROM ${other}.${q(view)}${readViewArguments(view)}`),
    ...["_samples", "_events", "_series", "_states_current", "_state_changes", "_rollups", "_sources", "_checkpoints"].flatMap((table) => [
      `SELECT * FROM ${other}.${q(table)}`,
      `SELECT * FROM ${own}.${q(table)}`,
    ]),
    `INSERT INTO ${own}._events(id) VALUES(generateUUIDv4())`,
    `ALTER TABLE ${own}._events DELETE WHERE 1`,
    `DROP TABLE ${own}._events`,
    `TRUNCATE TABLE ${own}._events`,
    `OPTIMIZE TABLE ${own}._events FINAL`,
    `CREATE USER ${q(base.readUser + "_evil")}`,
    `GRANT SELECT ON ${own}.* TO ${q(base.readUser)}`,
    `CREATE ROW POLICY evil ON ${own}._events FOR SELECT USING 1 TO ${q(base.readUser)}`,
    "SELECT * FROM url('http://127.0.0.1:1/', CSV, 'x String')",
    "SELECT * FROM remote('127.0.0.1:1',system.one)",
    "SELECT * FROM remoteSecure('127.0.0.1:1',system.one)",
    "SELECT * FROM s3('https://example.com/x.csv',CSV,'x String')",
    "SELECT * FROM mysql('127.0.0.1:1','db','t','u','p')",
    "SELECT * FROM postgresql('127.0.0.1:1','db','t','u','p')",
    "SELECT * FROM cluster('default',system.one)",
    "SELECT * FROM clusterAllReplicas('default',system.one)",
    "SELECT * FROM jdbc('jdbc:fixture','SELECT 1')",
    `SELECT * FROM view(SELECT * FROM ${other}.events)`,
    "SELECT * FROM s3Cluster('default','https://example.com/x.csv',CSV,'x String')",
    "SELECT * FROM azureBlobStorage('https://example.com','container','file',CSV,'x String')",
    "SELECT * FROM iceberg('https://example.com/table')",
    "SELECT * FROM deltaLake('https://example.com/table')",
    "SELECT * FROM hdfs('hdfs://127.0.0.1:1/file',CSV,'x String')",
    "SELECT * FROM mongodb('127.0.0.1:1','db','collection','u','p','x String')",
    "SELECT * FROM redis('127.0.0.1:1','key','key String, value String')",
    "INSERT INTO FUNCTION url('http://127.0.0.1:1/',CSV,'x UInt8') SELECT 1",
    `CREATE NAMED COLLECTION ${q(base.database + "_collection")} AS url='http://127.0.0.1:1'`,
    "SELECT * FROM system.named_collections",
    `SELECT * FROM url(${q(collection)})`,
    "SELECT * FROM system.query_cache",
    "SYSTEM DROP QUERY CACHE",
    ...["query_log", "processes", "parts", "users", "grants", "row_policies", "asynchronous_metrics", "dictionaries", "macros"].map(
      (table) => `SELECT * FROM system.${table}`,
    ),
    `SHOW CREATE USER ${q(base.readUser)}`,
  ];
};

export const deniedReadCodes = (query: string): number[] =>
  query.includes("SELECT sensitive FROM") || query.includes("SELECT payload FROM")
    ? [47, 497]
    : query.includes("merge(")
      ? [636, 497]
      : query.includes("file(")
        ? [291, 497]
        : query.includes("dictGet(")
          ? [36, 497]
          : query.includes("input(")
            ? [477, 497]
            : [497];
