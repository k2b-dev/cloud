import { sql } from "@k2b/cloud";
import type { RequestActor } from "@k2b/cloud/contracts";
import type { AccessSubject } from "@k2b/cloud/server";
import { z } from "zod";
import {
  type BaseSchemaRead,
  BaseSchemaReadSchema,
  SCHEMA_CACHE_SECONDS,
  SCHEMA_DIMENSIONS_SAMPLE_MAX_BYTES,
  SCHEMA_EVENT_WINDOW_DAYS,
  SCHEMA_FIELD_SAMPLE_ROWS,
  SCHEMA_FIELD_TYPES,
  SCHEMA_JSON_SAMPLE_MAX_BYTES,
  SCHEMA_MAX_DIMENSIONS,
  SCHEMA_MAX_EVENT_KINDS,
  SCHEMA_MAX_FIELDS,
  SCHEMA_MAX_METRICS,
  SCHEMA_MAX_STATE_KEYS,
  SCHEMA_METRIC_SAMPLE_WINDOW_HOURS,
  SCHEMA_NAME_MAX_LENGTH,
  SCHEMA_RESULT_MAX_BYTES,
  SCHEMA_SAMPLE_ROWS,
  SCHEMA_TEXT_MAX_LENGTH,
  type SchemaField,
  type SchemaFieldType,
  SchemaKindFilterSchema,
} from "../schema-contracts";
import type { ReadProfileName } from "../store/admin-contracts";
import { type SqlRows, sqlRunner } from "../store/sql-run";
import { accessScopeFor, requireBaseAccess } from "./access-control";
import { resolvePublicId } from "./public-resources";
import { sqlAdmission } from "./sql-admission";
import { SqlError } from "./sql-errors";
import { sqlFailure } from "./sql-service";

export type SchemaReadError = {
  code: string;
  message: string;
  status: 400 | 403 | 422 | 429 | 503;
  retryAfter?: number;
  resetAt?: string;
};
export type SchemaReadResult = { ok: true; data: BaseSchemaRead } | { ok: false; error: SchemaReadError };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A ClickHouse string literal. Names never travel as `:name` parameters: Pulse types a value such as `5m` or `12` by its shape. */
export const sqlStringLiteral = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const instant = (ms: number) => `fromUnixTimestamp64Milli(toInt64(${Math.floor(ms)}),'UTC')`;
const clipped = (column: string, max = SCHEMA_TEXT_MAX_LENGTH) => `substringUTF8(${column},1,${max})`;
const bounded = (column: string, maxBytes: number) => `if(length(${column})<=${maxBytes},${column},'')`;
/** The coarse JSON type of a raw top-level value; strings keep their quotes in raw form. */
const rawType = (raw: string) =>
  `multiIf(startsWith(${raw},'"'),'string',startsWith(${raw},'{'),'object',startsWith(${raw},'['),'array',${raw} IN ('true','false'),'boolean',${raw}='null','null','number')`;

/**
 * Every statement reads only the base's read views: `events` never contains the confidential block or the payload.
 * Field rows per kind: one row with an empty field name carries rows without attributes, then the most frequent fields.
 */
export const schemaStatements = {
  eventFields: (input: { since: number; kind?: string }) => {
    const where =
      input.kind === undefined
        ? `ts>=${instant(input.since)} AND kind IN (SELECT kind FROM events WHERE ts>=${instant(input.since)} GROUP BY kind ORDER BY max(ts) DESC, kind LIMIT ${SCHEMA_MAX_EVENT_KINDS})`
        : `kind=${sqlStringLiteral(input.kind)} AND ts>=${instant(input.since)}`;
    return `SELECT kind, total, field, present, n_string, n_number, n_boolean, n_object, n_array, n_null,
  countIf(field!='') OVER (PARTITION BY kind) AS field_count
FROM (
  SELECT kind, any(total) AS total, field, count() AS present,
    countIf(t='string') AS n_string, countIf(t='number') AS n_number, countIf(t='boolean') AS n_boolean,
    countIf(t='object') AS n_object, countIf(t='array') AS n_array, countIf(t='null') AS n_null
  FROM (
    SELECT kind, total, tupleElement(pair,1) AS field, ${rawType("tupleElement(pair,2)")} AS t
    FROM (
      SELECT kind, attributes, count() OVER (PARTITION BY kind) AS total
      FROM (SELECT kind, attributes FROM events WHERE ${where} ORDER BY kind, ts DESC LIMIT ${SCHEMA_FIELD_SAMPLE_ROWS} BY kind)
    )
    LEFT ARRAY JOIN JSONExtractKeysAndValuesRaw(attributes) AS pair
  )
  GROUP BY kind, field
)
ORDER BY kind, field!='', present DESC, field
LIMIT ${SCHEMA_MAX_FIELDS + 1} BY kind`;
  },
  eventSamples: (input: { since: number; kind: string }) =>
    `SELECT toString(id) AS event_id, toUnixTimestamp64Milli(ts) AS at, value, toString(source_id) AS source,
  ${clipped("actor_id")} AS actor, ${clipped("session_id")} AS session, ${clipped("correlation_id")} AS correlation,
  ${clipped("resource_key")} AS resource, ${bounded("dimensions", SCHEMA_DIMENSIONS_SAMPLE_MAX_BYTES)} AS dims,
  ${bounded("attributes", SCHEMA_JSON_SAMPLE_MAX_BYTES)} AS attrs, length(attributes)>${SCHEMA_JSON_SAMPLE_MAX_BYTES} AS attrs_cut
FROM events WHERE kind=${sqlStringLiteral(input.kind)} AND ts>=${instant(input.since)}
ORDER BY ts DESC LIMIT ${SCHEMA_SAMPLE_ROWS}`,
  metricSamples: (input: { since: number; metric: string }) => {
    const metric = sqlStringLiteral(input.metric);
    return `SELECT toUnixTimestamp64Milli(p.ts) AS at, p.value AS value, toString(s.source_id) AS source,
  ${clipped("s.resource_key")} AS resource, ${bounded("s.dimensions", SCHEMA_DIMENSIONS_SAMPLE_MAX_BYTES)} AS dims
FROM (SELECT series_id, ts, value FROM samples WHERE ts>=${instant(input.since)} AND series_id IN (SELECT series_id FROM series WHERE metric=${metric})) AS p
INNER JOIN (SELECT series_id, source_id, resource_key, dimensions FROM series WHERE metric=${metric}) AS s USING (series_id)
ORDER BY p.ts DESC LIMIT ${SCHEMA_SAMPLE_ROWS}`;
  },
  stateSamples: (input: { key: string }) =>
    `SELECT ${clipped("variant_key")} AS variant, ${bounded("value", SCHEMA_JSON_SAMPLE_MAX_BYTES)} AS state_value,
  length(value)>${SCHEMA_JSON_SAMPLE_MAX_BYTES} AS value_cut, toUnixTimestamp64Milli(updated_at) AS at, toString(source_id) AS source,
  ${clipped("resource_key")} AS resource, ${bounded("dimensions", SCHEMA_DIMENSIONS_SAMPLE_MAX_BYTES)} AS dims
FROM states WHERE state_key=${sqlStringLiteral(input.key)}
ORDER BY updated_at DESC LIMIT ${SCHEMA_SAMPLE_ROWS}`,
};

const count = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};
const text = (value: unknown, max = SCHEMA_TEXT_MAX_LENGTH) => (value === null || value === undefined ? "" : String(value).slice(0, max));
const iso = (value: unknown) => new Date(Number(value)).toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

const JsonObject = z.record(z.string(), z.unknown());
export const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JsonObject.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export type SampledKind = { sampledRows: number; fields: SchemaField[]; fieldsTruncated: boolean };

/** Turns `schemaStatements.eventFields` rows into fields per kind. Rows are untrusted store output. */
export const summarizeAttributeFields = (rows: unknown[][]): Map<string, SampledKind> => {
  const kinds = new Map<string, SampledKind>();
  for (const row of rows) {
    const [kind, total, field, present, ...rest] = row;
    if (typeof kind !== "string") continue;
    const sampledRows = Math.min(count(total), SCHEMA_FIELD_SAMPLE_ROWS);
    const fieldCount = count(rest[SCHEMA_FIELD_TYPES.length]);
    let entry = kinds.get(kind);
    if (!entry) {
      entry = { sampledRows, fields: [], fieldsTruncated: fieldCount > SCHEMA_MAX_FIELDS };
      kinds.set(kind, entry);
    }
    if (typeof field !== "string" || field === "" || sampledRows === 0 || entry.fields.length >= SCHEMA_MAX_FIELDS) continue;
    const counts = SCHEMA_FIELD_TYPES.map((type, index) => ({ type, n: count(rest[index]) }))
      .filter((item) => item.n > 0)
      .sort((a, b) => b.n - a.n || SCHEMA_FIELD_TYPES.indexOf(a.type) - SCHEMA_FIELD_TYPES.indexOf(b.type));
    if (!counts.length) continue;
    const types: SchemaFieldType[] = counts.map((item) => item.type);
    const presentRows = Math.min(count(present), sampledRows);
    entry.fields.push({
      key: field.slice(0, SCHEMA_NAME_MAX_LENGTH),
      type: types.find((type) => type !== "null") ?? "null",
      types,
      present: presentRows,
      fillRate: Math.round((presentRows / sampledRows) * 10_000) / 10_000,
    });
  }
  return kinds;
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Keeps a result within `maxBytes`: drops samples, then event fields, then entries from the end of the longest list. */
export const fitSchemaResult = (result: BaseSchemaRead, maxBytes = SCHEMA_RESULT_MAX_BYTES): BaseSchemaRead => {
  let size = bytes(result);
  if (size <= maxBytes) return result;
  const out: BaseSchemaRead = structuredClone(result);
  out.truncated = true;
  const drop = <T extends Record<K, unknown[] | null>, K extends string>(items: T[], key: K) => {
    for (let index = items.length - 1; index >= 0 && size > maxBytes; index--) {
      const item = items[index]!;
      const value = item[key];
      if (value === null) continue;
      size -= bytes(value) - 4;
      item[key] = null as T[K];
    }
  };
  drop(out.metrics.items, "samples");
  drop(out.states.items, "samples");
  drop(out.events.items, "samples");
  drop(out.events.items, "fields");
  const lists = [out.metrics.items, out.states.items, out.events.items];
  while (size > maxBytes) {
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    if (!longest.length) break;
    size -= bytes(longest.pop()) + 1;
    if (size <= maxBytes) size = bytes(out);
  }
  return out;
};

type SchemaBase = {
  id: string;
  short_id: string;
  timezone: string;
  profile: ReadProfileName;
  database_name: string;
  queries_per_hour: number;
  state: string;
  reset_generation: string;
};

const failure = (error: unknown): { ok: false; error: SchemaReadError } => {
  if (error instanceof SqlError) return sqlFailure(error);
  throw error;
};
const parseCached = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const noAccess = () => new SqlError("NO_READ_ACCESS", "Read access to this Pulse base is required");

const authorizedBase = async (input: { actor: RequestActor; accessSubject: AccessSubject; baseId: string }): Promise<SchemaBase> => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) throw noAccess();
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) throw noAccess();
  const access = await requireBaseAccess(baseId, scope.data, "read");
  if (!access.ok) throw noAccess();
  const [base] = await sql<SchemaBase[]>`
    SELECT b.id,b.short_id,b.timezone,s.profile,s.database_name,s.queries_per_hour,s.state,s.reset_generation::text AS reset_generation
    FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id
    WHERE b.id=${baseId}::uuid AND b.deletion_started_at IS NULL`;
  if (!base || base.state !== "active") throw new SqlError("STORE_UNAVAILABLE", "The Pulse base data store is not active");
  return base;
};

const readCatalog = async (baseId: string, kind: string | undefined) => {
  const metrics = await sql<
    {
      id: string;
      name: string;
      type: "gauge" | "counter";
      unit: string | null;
      series: number;
      last_sample_at: Date | null;
      total: number;
    }[]
  >`
    SELECT d.id::text AS id,d.name,d.type::text AS type,d.unit,count(s.id)::int AS series,max(s.last_sample_at) AS last_sample_at,count(*) OVER ()::int AS total
    FROM pulse.metric_defs d LEFT JOIN pulse.metric_series s ON s.metric_id=d.id
    WHERE d.base_id=${baseId}::uuid ${kind === undefined ? sql`` : sql`AND d.name=${kind}`}
    GROUP BY d.id ORDER BY max(s.last_sample_at) DESC NULLS LAST, d.name LIMIT ${SCHEMA_MAX_METRICS + 1}`;
  const listed = metrics.slice(0, SCHEMA_MAX_METRICS);
  const dimensions = listed.length
    ? await sql<{ metric_id: string; key: string; value_count: number }[]>`
        SELECT s.metric_id::text AS metric_id,k.key,count(DISTINCT k.value)::int AS value_count
        FROM pulse.metric_series s CROSS JOIN LATERAL jsonb_each_text(s.dimensions) AS k(key,value)
        WHERE s.base_id=${baseId}::uuid AND s.metric_id=ANY(${sql.array(
          listed.map((metric) => metric.id),
          "UUID",
        )})
        GROUP BY s.metric_id,k.key ORDER BY s.metric_id,count(DISTINCT k.value) DESC,k.key`
    : [];
  const events = await sql<{ kind: string; first_seen_at: Date; last_seen_at: Date; total: number }[]>`
    SELECT kind,first_seen_at,last_seen_at,count(*) OVER ()::int AS total FROM pulse.event_kinds
    WHERE base_id=${baseId}::uuid ${kind === undefined ? sql`` : sql`AND kind=${kind}`}
    ORDER BY last_seen_at DESC, kind LIMIT ${SCHEMA_MAX_EVENT_KINDS + 1}`;
  const states = await sql<{ state_key: string; first_seen_at: Date; variants: number; updated_at: Date | null; total: number }[]>`
    SELECT k.state_key,k.first_seen_at,count(v.variant_key)::int AS variants,max(v.updated_at) AS updated_at,count(*) OVER ()::int AS total
    FROM pulse.state_keys k LEFT JOIN pulse.state_variants v ON v.base_id=k.base_id AND v.state_key=k.state_key
    WHERE k.base_id=${baseId}::uuid ${kind === undefined ? sql`` : sql`AND k.state_key=${kind}`}
    GROUP BY k.state_key,k.first_seen_at ORDER BY max(v.updated_at) DESC NULLS LAST, k.state_key LIMIT ${SCHEMA_MAX_STATE_KEYS + 1}`;
  const keysByMetric = new Map<string, { key: string; values: number }[]>();
  let dimensionsCut = false;
  for (const row of dimensions) {
    const keys = keysByMetric.get(row.metric_id) ?? [];
    if (keys.length < SCHEMA_MAX_DIMENSIONS) keys.push({ key: row.key.slice(0, SCHEMA_NAME_MAX_LENGTH), values: row.value_count });
    else dimensionsCut = true;
    keysByMetric.set(row.metric_id, keys);
  }
  return {
    truncated:
      metrics.length > SCHEMA_MAX_METRICS ||
      events.length > SCHEMA_MAX_EVENT_KINDS ||
      states.length > SCHEMA_MAX_STATE_KEYS ||
      dimensionsCut,
    metrics: {
      total: metrics[0]?.total ?? 0,
      items: listed.map((metric) => ({ ...metric, dimensions: keysByMetric.get(metric.id) ?? [] })),
    },
    events: { total: events[0]?.total ?? 0, items: events.slice(0, SCHEMA_MAX_EVENT_KINDS) },
    states: { total: states[0]?.total ?? 0, items: states.slice(0, SCHEMA_MAX_STATE_KEYS) },
  };
};

type Statement = { name: "fields" | "events" | "metrics" | "states"; sql: string };

const runStatements = async (base: SchemaBase, statements: Statement[], countQuota: boolean, signal?: AbortSignal) => {
  const results = new Map<Statement["name"], SqlRows>();
  if (!statements.length) return results;
  const runId = crypto.randomUUID();
  // One admitted slot for all statements. Only a named read counts toward the hourly quota; the cached overview does not.
  const lease = await sqlAdmission.acquire({ baseId: base.id, runId, quota: base.queries_per_hour, countQuota, signal });
  try {
    for (const statement of statements) {
      if (signal?.aborted) throw new SqlError("CANCELLED", "Query cancelled");
      results.set(
        statement.name,
        await sqlRunner.run({
          baseId: base.id,
          database: base.database_name,
          profile: base.profile,
          timezone: base.timezone,
          sql: statement.sql,
          runId,
          signal,
          executionDeadline: lease.executionDeadline,
        }),
      );
    }
  } finally {
    await lease.release().catch(() => {});
  }
  return results;
};

const sourceShortIds = async (baseId: string, results: Map<Statement["name"], SqlRows>) => {
  const ids = new Set<string>();
  for (const [name, rows] of results) {
    if (name === "fields") continue;
    const column = rows.columns.findIndex((item) => item.name === "source");
    for (const row of rows.rows) if (typeof row[column] === "string" && z.uuid().safeParse(row[column]).success) ids.add(row[column]);
  }
  if (!ids.size) return new Map<string, string>();
  const rows = await sql<{ id: string; short_id: string }[]>`
    SELECT id::text AS id,short_id FROM pulse.sources WHERE base_id=${baseId}::uuid AND NOT deleted AND id=ANY(${sql.array([...ids], "UUID")})`;
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

const byName = (rows: SqlRows | undefined) => {
  if (!rows) return [];
  return rows.rows.map((row) => Object.fromEntries(rows.columns.map((column, index) => [column.name, row[index]])));
};

const stateValue = (raw: unknown): string | number | boolean | null => {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return parsed;
  } catch {
    /* Not JSON: return the stored text. */
  }
  return raw.slice(0, SCHEMA_JSON_SAMPLE_MAX_BYTES);
};

const computeSchema = async (base: SchemaBase, kind: string | undefined, signal?: AbortSignal): Promise<BaseSchemaRead> => {
  const catalog = await readCatalog(base.id, kind);
  const named = kind !== undefined;
  const newestEvent = catalog.events.items[0]?.last_seen_at.getTime();
  const newestSample = catalog.metrics.items[0]?.last_sample_at?.getTime();
  const eventsSince = newestEvent === undefined ? undefined : newestEvent - SCHEMA_EVENT_WINDOW_DAYS * DAY_MS;
  const statements: Statement[] = [];
  if (eventsSince !== undefined) statements.push({ name: "fields", sql: schemaStatements.eventFields({ since: eventsSince, kind }) });
  // Entries are read only for a named kind: an overview of every kind's newest entries would not fit one answer.
  if (kind !== undefined) {
    if (eventsSince !== undefined) statements.push({ name: "events", sql: schemaStatements.eventSamples({ since: eventsSince, kind }) });
    if (newestSample !== undefined)
      statements.push({
        name: "metrics",
        sql: schemaStatements.metricSamples({ since: newestSample - SCHEMA_METRIC_SAMPLE_WINDOW_HOURS * HOUR_MS, metric: kind }),
      });
    if (catalog.states.items.length) statements.push({ name: "states", sql: schemaStatements.stateSamples({ key: kind }) });
  }
  if (signal?.aborted) throw new SqlError("CANCELLED", "Query cancelled");
  const results = await runStatements(base, statements, named, signal);
  const sources = await sourceShortIds(base.id, results);
  const source = (value: unknown) => (typeof value === "string" ? (sources.get(value) ?? null) : null);
  const fields = summarizeAttributeFields(results.get("fields")?.rows ?? []);
  const eventSamples = byName(results.get("events")).map((row) => ({
    id: text(row.event_id),
    ts: iso(row.at),
    value: typeof row.value === "number" ? row.value : null,
    sourceId: source(row.source),
    actorId: text(row.actor),
    sessionId: text(row.session),
    correlationId: text(row.correlation),
    resourceKey: text(row.resource),
    dimensions: parseJsonObject(row.dims),
    attributes: parseJsonObject(row.attrs),
    attributesTruncated: Number(row.attrs_cut) === 1,
  }));
  const metricSamples = byName(results.get("metrics")).map((row) => ({
    ts: iso(row.at),
    value: Number(row.value),
    sourceId: source(row.source),
    resourceKey: text(row.resource),
    dimensions: parseJsonObject(row.dims),
  }));
  const stateSamples = byName(results.get("states")).map((row) => ({
    variantKey: text(row.variant),
    value: stateValue(row.state_value),
    valueTruncated: Number(row.value_cut) === 1,
    updatedAt: iso(row.at),
    sourceId: source(row.source),
    resourceKey: text(row.resource),
    dimensions: parseJsonObject(row.dims),
  }));
  const result: BaseSchemaRead = {
    baseId: base.short_id,
    generatedAt: new Date().toISOString(),
    kind: kind ?? null,
    truncated: catalog.truncated || [...results.values()].some((rows) => rows.truncated),
    metrics: {
      total: catalog.metrics.total,
      items: catalog.metrics.items.map((metric) => ({
        name: metric.name.slice(0, SCHEMA_NAME_MAX_LENGTH),
        type: metric.type,
        unit: metric.unit === null ? null : text(metric.unit),
        seriesCount: metric.series,
        lastSampleAt: isoOrNull(metric.last_sample_at),
        dimensions: metric.dimensions,
        samples: named ? metricSamples : null,
      })),
    },
    events: {
      total: catalog.events.total,
      items: catalog.events.items.map((event) => {
        const sampled = fields.get(event.kind);
        return {
          kind: event.kind.slice(0, SCHEMA_NAME_MAX_LENGTH),
          firstSeenAt: event.first_seen_at.toISOString(),
          lastSeenAt: event.last_seen_at.toISOString(),
          sampledRows: sampled?.sampledRows ?? 0,
          fields: sampled?.fields ?? null,
          fieldsTruncated: sampled?.fieldsTruncated ?? false,
          samples: named ? eventSamples : null,
        };
      }),
    },
    states: {
      total: catalog.states.total,
      items: catalog.states.items.map((state) => ({
        key: state.state_key.slice(0, SCHEMA_NAME_MAX_LENGTH),
        firstSeenAt: state.first_seen_at.toISOString(),
        variantCount: state.variants,
        updatedAt: isoOrNull(state.updated_at),
        samples: named ? stateSamples : null,
      })),
    },
  };
  return fitSchemaResult(BaseSchemaReadSchema.parse(result));
};

/**
 * The data catalog of one readable base: metric names, event kinds with inferred attribute fields, and state keys.
 * A named kind adds its newest entries. Reads only the base's read views, so confidential event data never appears.
 * Every entry (HTTP, capability, CLI) calls here; results are cached per base and clear generation for 5 minutes.
 */
export const readBaseSchema = async (input: {
  actor: RequestActor;
  accessSubject: AccessSubject;
  baseId: string;
  signal?: AbortSignal;
  kind?: string;
}): Promise<SchemaReadResult> => {
  const kind = input.kind === undefined ? undefined : SchemaKindFilterSchema.safeParse(input.kind);
  if (kind && !kind.success)
    return { ok: false, error: { code: "BAD_INPUT", message: kind.error.issues[0]?.message ?? "Invalid kind", status: 400 } };
  try {
    const base = await authorizedBase(input);
    if (input.signal?.aborted) throw new SqlError("CANCELLED", "Query cancelled");
    const name = kind?.data;
    const kindKey = name === undefined ? "*" : new Bun.CryptoHasher("sha256").update(name).digest("hex");
    const cacheKey = `schema:${base.id}:${base.reset_generation}:${kindKey}:${Math.floor(Date.now() / (SCHEMA_CACHE_SECONDS * 1000))}`;
    const cached = await sqlAdmission.cached(cacheKey);
    if (cached) {
      const parsed = BaseSchemaReadSchema.safeParse(parseCached(cached));
      if (parsed.success) return { ok: true, data: parsed.data };
    }
    const data = await computeSchema(base, name, input.signal);
    // A failed cache write costs only a recomputation on the next read.
    await sqlAdmission.cache(cacheKey, JSON.stringify(data)).catch(() => {});
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
};
