import { z } from "zod";
import { SQL_HELPER_VIEWS, sqlHelperStatements } from "./sql-helpers";
import { quoteIdentifier as q, StorePrefix } from "./validation";

export const READ_VIEWS = ["samples", "rollups", "series", "events", "states", "sources", ...SQL_HELPER_VIEWS] as const;
export const DATA_TABLES = ["_samples", "_rollups", "_series", "_events", "_states_current", "_state_changes"] as const;
export type BaseRetention = { rawRetentionDays: number; rollupRetentionDays: number; sensitiveRetentionHours: number };
export type BaseSchemaContext = BaseRetention & { database: string; prefix: string };
export const baseStoreNames = (baseId: string, prefix = "pulse_") => {
  StorePrefix.parse(prefix);
  z.uuid().parse(baseId);
  const hex = baseId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("INVALID_INPUT");
  return { database: `${prefix}${hex}`, readUser: `${prefix}r_${hex}` };
};
export const assertStoreName = (name: string, prefix: string, reader = false) => {
  StorePrefix.parse(prefix);
  if (!name.startsWith(prefix) || !(reader ? /^r_[0-9a-f]{32}$/ : /^[0-9a-f]{32}$/).test(name.slice(prefix.length)))
    throw new Error("INVALID_INPUT");
  return q(name);
};
const retention = (ctx: BaseSchemaContext) => {
  const raw = z.number().int().min(1).max(3650).parse(ctx.rawRetentionDays);
  const rollup = z.number().int().min(1).max(3650).parse(ctx.rollupRetentionDays);
  const sensitive = z.number().int().min(1).max(8760).parse(ctx.sensitiveRetentionHours);
  return {
    raw: `toDateTime(ts) + toIntervalDay(${raw})`,
    rollup: `bucket + INTERVAL 1 HOUR + toIntervalDay(${rollup})`,
    sensitive: `toDateTime(ts) + toIntervalHour(${sensitive})`,
    changes: `toDateTime(changed_at) + toIntervalDay(${raw})`,
  };
};
export const baseTtlStatements = (ctx: BaseSchemaContext) => {
  const db = assertStoreName(ctx.database, ctx.prefix),
    ttl = retention(ctx);
  return [
    `ALTER TABLE ${db}._events MODIFY TTL ${ttl.raw}`,
    `ALTER TABLE ${db}._rollups MODIFY TTL ${ttl.rollup}`,
    `ALTER TABLE ${db}._state_changes MODIFY TTL ${ttl.changes}`,
    `ALTER TABLE ${db}._events MODIFY COLUMN sensitive String DEFAULT '' TTL ${ttl.sensitive}`,
    ...baseReadRetentionStatements(ctx),
  ];
};
export const BASE_SCHEMA_VERSIONS = [
  {
    version: 1,
    statements: (ctx: BaseSchemaContext): string[] => {
      const db = assertStoreName(ctx.database, ctx.prefix),
        ttl = retention(ctx);
      const table = (name: string, columns: string, order: string, extra = "", partition = "") =>
        `CREATE TABLE IF NOT EXISTS ${db}.${q(name)} (${columns}) ENGINE = ReplacingMergeTree(version) ${partition} ORDER BY (${order}) ${extra}`;
      const view = (name: string, select: string) =>
        `CREATE OR REPLACE VIEW ${db}.${q(name)} DEFINER = CURRENT_USER SQL SECURITY DEFINER AS ${select}`;
      const latest = (tableName: string, keys: string, columns: string[]) =>
        `SELECT ${keys}, ${columns.map((c) => `argMax(tuple(src.${c}), src.version).1 AS ${c}`).join(", ")} FROM ${db}.${q(tableName)} AS src GROUP BY ${keys}`;
      // tuple preserves nullable fields: argMax(column, version) alone skips NULL updates. Every aggregate reads
      // `src.` columns: an output alias with a source column's name would otherwise nest one aggregate in another.
      const eventColumns = [
        "id",
        "ts",
        "kind",
        "source_id",
        "value",
        "actor_id",
        "session_id",
        "correlation_id",
        "resource_key",
        "resource_type",
        "resource_id",
        "dimensions",
        "attributes",
      ];
      const rollupColumns = [
        "sample_count",
        "value_sum",
        "value_min",
        "value_max",
        "last_value",
        "last_ts",
        "increase",
        "increase_seconds",
      ];
      return [
        table(
          "_samples",
          "row_id UUID, series_id UUID, ts DateTime64(3, 'UTC'), value Float64, version UInt64",
          "series_id, ts, row_id",
          "",
          "PARTITION BY toYYYYMMDD(ts)",
        ),
        table(
          "_rollups",
          "series_id UUID, bucket DateTime('UTC'), sample_count UInt64, value_sum Float64, value_min Float64, value_max Float64, last_value Float64, last_ts DateTime64(3, 'UTC'), increase Float64, increase_seconds Float64, version UInt64",
          "series_id, bucket",
          `TTL ${ttl.rollup}`,
        ),
        table(
          "_series",
          "series_id UUID, metric String, type LowCardinality(String), unit String, source_id Nullable(UUID), resource_key String, resource_type String, resource_id String, dimensions String, version UInt64",
          "series_id",
        ),
        table(
          "_events",
          `id UUID, ts DateTime64(3, 'UTC'), kind String, source_id Nullable(UUID), value Nullable(Float64), actor_id String, session_id String, correlation_id String, resource_key String, resource_type String, resource_id String, dimensions String, attributes String, sensitive String DEFAULT '' TTL ${ttl.sensitive}, payload String, version UInt64`,
          "kind, ts, id",
          `TTL ${ttl.raw}`,
        ),
        table(
          "_states_current",
          "state_key String, variant_key String, value String, dimensions String, resource_key String, source_id Nullable(UUID), updated_at DateTime64(3, 'UTC'), version UInt64",
          "state_key, variant_key",
        ),
        table(
          "_state_changes",
          "id UUID, state_key String, variant_key String, value String, dimensions String, resource_key String, source_id Nullable(UUID), changed_at DateTime64(3, 'UTC'), version UInt64",
          "state_key, variant_key, changed_at, id",
          `TTL ${ttl.changes}`,
        ),
        table("_sources", "id UUID, short_id String, kind LowCardinality(String), name String, version UInt64", "id"),
        `CREATE TABLE IF NOT EXISTS ${db}._checkpoints (id UUID, at DateTime64(3, 'UTC')) ENGINE = MergeTree ORDER BY at`,
        view("samples", `SELECT series_id, ts, argMax(src.value, src.version) AS value FROM ${db}._samples AS src GROUP BY series_id, ts`),
        view(
          "rollups",
          `SELECT series_id, bucket, ${rollupColumns.map((c, i) => `tupleElement(argMax(tuple(${rollupColumns.map((column) => `src.${column}`).join(", ")}), src.version), ${i + 1}) AS ${c}`).join(", ")} FROM ${db}._rollups AS src GROUP BY series_id, bucket`,
        ),
        view(
          "series",
          latest("_series", "series_id", [
            "metric",
            "type",
            "unit",
            "source_id",
            "resource_key",
            "resource_type",
            "resource_id",
            "dimensions",
          ]),
        ),
        // FINAL deduplicates by the event's immutable (kind, ts, id) identity; hidden fields never enter the view.
        view("events", `SELECT ${eventColumns.join(", ")} FROM ${db}._events FINAL`),
        view(
          "states",
          latest("_states_current", "state_key, variant_key", ["value", "dimensions", "resource_key", "source_id", "updated_at"]),
        ),
        view("sources", latest("_sources", "id", ["short_id", "kind", "name"])),
      ];
    },
  },
  {
    version: 2,
    statements: (ctx: BaseSchemaContext): string[] => {
      const db = assertStoreName(ctx.database, ctx.prefix);
      const columns = ["value", "dimensions", "resource_key", "source_id", "updated_at"];
      return [
        `ALTER TABLE ${db}._sources ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0`,
        // Physical replacement must preserve the view's timestamp priority after a merge, too.
        // Atomic CREATE OR REPLACE reads the old table before swapping; replay copies rows again without losing them.
        `CREATE OR REPLACE TABLE ${db}._states_current (
          state_key String, variant_key String, value String, dimensions String, resource_key String,
          source_id Nullable(UUID), updated_at DateTime64(3, 'UTC'), version UInt64,
          merge_version UInt128 MATERIALIZED (bitShiftLeft(toUInt128(toInt128(toUnixTimestamp64Milli(updated_at)) + 9223372036854775808),64) + toUInt128(version))
        ) ENGINE = ReplacingMergeTree(merge_version) ORDER BY (state_key, variant_key)
        AS SELECT state_key, variant_key, value, dimensions, resource_key, source_id, updated_at, version FROM ${db}._states_current`,
        `CREATE OR REPLACE VIEW ${db}.states DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT state_key, variant_key, ${columns.map((c) => `argMax(tuple(src.${c}), tuple(src.updated_at, src.version)).1 AS ${c}`).join(", ")} FROM ${db}._states_current AS src GROUP BY state_key, variant_key`,
        `CREATE OR REPLACE VIEW ${db}.sources DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT id, short_id, kind, name FROM (SELECT id, argMax(src.short_id,src.version) AS short_id, argMax(src.kind,src.version) AS kind, argMax(src.name,src.version) AS name, argMax(src.deleted,src.version) AS deleted FROM ${db}._sources AS src GROUP BY id) WHERE deleted=0`,
        `ALTER TABLE ${db}._series ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0`,
        `CREATE OR REPLACE VIEW ${db}.series DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT series_id, metric, type, unit, source_id, resource_key, resource_type, resource_id, dimensions FROM ${db}._series FINAL WHERE deleted=0`,
      ];
    },
  },
  { version: 3, statements: (ctx: BaseSchemaContext): string[] => sqlHelperStatements(assertStoreName(ctx.database, ctx.prefix)) },
  { version: 4, statements: (ctx: BaseSchemaContext): string[] => baseReadRetentionStatements(ctx) },
];
export const LATEST_BASE_SCHEMA_VERSION = 4;

/** Read retention is independent of asynchronous TTL merges and delayed rollups.
 * Maintenance reads internal tables so it can still finish protected old hours. */
export const baseReadRetentionStatements = (ctx: BaseSchemaContext): string[] => {
  retention(ctx); // Validate every interpolated retention value.
  const db = assertStoreName(ctx.database, ctx.prefix);
  const rollupColumns = ["sample_count", "value_sum", "value_min", "value_max", "last_value", "last_ts", "increase", "increase_seconds"];
  const view = (name: string, select: string) =>
    `CREATE OR REPLACE VIEW ${db}.${q(name)} DEFINER = CURRENT_USER SQL SECURITY DEFINER AS ${select}`;
  return [
    view(
      "samples",
      `SELECT series_id,ts,argMax(src.value,src.version) AS value FROM ${db}._samples AS src
      WHERE ts>=toStartOfHour(now64(3,'UTC')-toIntervalDay(${ctx.rawRetentionDays})) GROUP BY series_id,ts`,
    ),
    view(
      "rollups",
      `SELECT series_id,bucket,${rollupColumns.map((c, i) => `tupleElement(argMax(tuple(${rollupColumns.map((column) => `src.${column}`).join(", ")}),src.version),${i + 1}) AS ${c}`).join(", ")}
      FROM ${db}._rollups AS src WHERE bucket>=toStartOfHour(now64(3,'UTC')-toIntervalDay(${ctx.rollupRetentionDays})) GROUP BY series_id,bucket`,
    ),
    view(
      "events",
      `SELECT id,ts,kind,source_id,value,actor_id,session_id,correlation_id,resource_key,resource_type,resource_id,dimensions,attributes
      FROM ${db}._events FINAL WHERE ts>=now64(3,'UTC')-toIntervalDay(${ctx.rawRetentionDays})`,
    ),
    // Helpers may calculate retained hourly history from protected raw rows while
    // aggregation is delayed. Direct raw reads still use the shorter raw cutoff.
    ...sqlHelperStatements(
      db,
      `(SELECT series_id,ts,argMax(src.value,src.version) AS value FROM ${db}._samples AS src
      WHERE ts>=toStartOfHour(now64(3,'UTC')-toIntervalDay(${Math.max(ctx.rawRetentionDays, ctx.rollupRetentionDays)})) GROUP BY series_id,ts)`,
      `toStartOfHour(now64(3,'UTC')-toIntervalDay(${ctx.rawRetentionDays}))`,
    ),
  ];
};
