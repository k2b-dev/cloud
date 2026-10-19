import { createHash, randomUUID } from "node:crypto";
import { err } from "@k2b/cloud/server";
import type { sql } from "bun";
import type { PulseIngestBatch } from "../contracts";
import { explicitPulseResource } from "../resource-model";
import { assertStoreName } from "../store/base-schema";
import type { baseStore } from "../store/base-store";
import { CLICKHOUSE_UUID_CHUNK_SIZE } from "../store/client";
import { enforceMetricSeriesBudget } from "./metric-cardinality";
import { markMetricHoursDirty } from "./metric-rollups";
import { lockStateIdentities } from "./state-transitions";
import { normalizeDimensions } from "./telemetry-values";

export type PulseSqlClient = typeof sql;
export type IngestStore = Pick<typeof baseStore, "prefix" | "query" | "clock" | "prepare">;
export const valueHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deterministicRowId = (sourceId: string, key: string, collection: string, ordinal: number): string => {
  const hex = valueHash([sourceId, key, collection, ordinal]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export const ingestVersion = (acceptedAt: Date, ordinal: number): string =>
  (BigInt(acceptedAt.getTime()) * 100_000n + BigInt(ordinal)).toString();

export const prepareIngestBatch = (batch: PulseIngestBatch, sourceId: string, acceptedAt: Date, key?: string | null) => {
  // Reused keys start a new namespace; retries reuse the reservation's acceptance time.
  const reservationKey = key ? valueHash([key, acceptedAt.toISOString()]) : null;
  let ordinal = 0;
  const common = (
    collection: string,
    ts: string | undefined,
    resource: Parameters<typeof explicitPulseResource>[0],
    input: Parameters<typeof normalizeDimensions>[0],
  ) => {
    const dimensions = normalizeDimensions(input),
      identity = explicitPulseResource(resource);
    const current = ordinal++;
    return {
      ordinal: current,
      id: reservationKey ? deterministicRowId(sourceId, reservationKey, collection, current) : randomUUID(),
      version: ingestVersion(acceptedAt, current),
      ts: ts ? new Date(ts).toISOString() : acceptedAt.toISOString(),
      dimensions,
      resourceKey: identity?.key ?? null,
      resourceType: identity?.type ?? null,
      resourceId: identity?.id ?? null,
      variantKey: valueHash([sourceId, identity?.key ?? null, valueHash(dimensions)]),
    };
  };
  return {
    metrics: (batch.metrics ?? []).map((m) => {
      const row = common("metrics", m.ts, m.resource, m.dimensions);
      return { ...row, name: m.name, value: m.value, unit: m.unit ?? null, metricType: m.type ?? "gauge", seriesKey: row.variantKey };
    }),
    events: (batch.events ?? []).map((e) => ({
      ...common("events", e.ts, e.resource, e.dimensions),
      kind: e.kind,
      value: e.value ?? null,
      actorId: e.actorId ?? "",
      sessionId: e.sessionId ?? "",
      correlationId: e.correlationId ?? "",
      attributes: e.attributes ?? {},
      sensitive: e.sensitive ?? {},
      payload: e.payload ?? {},
    })),
    states: (batch.states ?? []).map((s) => ({ ...common("states", s.ts, s.resource, s.dimensions), key: s.key, value: s.value })),
  };
};
export type PreparedIngestBatch = ReturnType<typeof prepareIngestBatch>;
export type SeriesRow = {
  id: string;
  name: string;
  series_key: string;
  mirrored: boolean;
  last_sample_at: Date | null;
  type: string;
  unit: string | null;
  source_id: string | null;
  dimensions: Record<string, string>;
  resource_key: string | null;
  resource_type: string | null;
  resource_id: string | null;
};
export const loadBatchSeries = async (baseId: string, batch: PreparedIngestBatch, db: PulseSqlClient): Promise<SeriesRow[]> => {
  if (!batch.metrics.length) return [];
  return db<SeriesRow[]>`SELECT s.*,d.name,d.type,d.unit FROM pulse.metric_series s JOIN pulse.metric_defs d ON d.id=s.metric_id
    JOIN (SELECT DISTINCT name,"seriesKey" FROM jsonb_to_recordset((${JSON.stringify(batch.metrics)}::jsonb #>> '{}')::jsonb) AS i(name text,"seriesKey" text)) i ON i.name=d.name AND i."seriesKey"=s.series_key
    WHERE s.base_id=${baseId}::uuid`;
};

/** T1 owns a base advisory lock. Every cap decision and reservation commits before any insert. */
export const registerIngestBatch = async (params: {
  baseId: string;
  sourceId: string;
  database: string;
  batch: PreparedIngestBatch;
  db: PulseSqlClient;
  store: IngestStore;
  now: Date;
}) => {
  const { baseId, sourceId, batch, db, store, now } = params;
  const [limits] =
    await db`SELECT s.max_series,s.max_event_kinds,s.max_state_keys,b.retention_days FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE base_id=${baseId}::uuid`;
  if (!limits) throw err.notFound("Pulse base store");
  if (batch.metrics.length) {
    const input = JSON.stringify(batch.metrics);
    await db`INSERT INTO pulse.metric_defs(base_id,name,type,unit)
      SELECT DISTINCT ${baseId}::uuid,name,"metricType"::pulse.metric_type,unit
      FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS i(name text,"metricType" text,unit text)
      ON CONFLICT(base_id,name) DO NOTHING`;
    const [mismatch] =
      await db`SELECT i.name FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS i(name text,"metricType" text,unit text)
      JOIN pulse.metric_defs d ON d.base_id=${baseId}::uuid AND d.name=i.name
      WHERE d.type::text<>i."metricType" OR d.unit IS DISTINCT FROM i.unit LIMIT 1`;
    if (mismatch) throw err.badInput("Metric type and unit must match the existing definition");
    await enforceMetricSeriesBudget(
      baseId,
      batch.metrics.map((m) => ({ metric: m.name, seriesKey: m.seriesKey })),
      db,
    );
    const [newSeries] = await db<{ name: string }[]>`SELECT i.name
      FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS i(name text,"seriesKey" text)
      JOIN pulse.metric_defs d ON d.base_id=${baseId}::uuid AND d.name=i.name
      WHERE NOT EXISTS(SELECT 1 FROM pulse.metric_series s WHERE s.metric_id=d.id AND s.series_key=i."seriesKey") LIMIT 1`;
    await db`INSERT INTO pulse.metric_series(base_id,metric_id,source_id,series_key,dimensions,resource_key,resource_type,resource_id,created_at,last_seen_at)
      SELECT DISTINCT ${baseId}::uuid,d.id,${sourceId}::uuid,i."seriesKey",i.dimensions,i."resourceKey",i."resourceType",i."resourceId",${now}::timestamptz,${now}::timestamptz
      FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS i(name text,"seriesKey" text,dimensions jsonb,"resourceKey" text,"resourceType" text,"resourceId" text)
      JOIN pulse.metric_defs d ON d.base_id=${baseId}::uuid AND d.name=i.name
      ON CONFLICT(base_id,metric_id,series_key) DO UPDATE SET last_seen_at=greatest(pulse.metric_series.last_seen_at,EXCLUDED.last_seen_at)`;
    const [count] = await db`SELECT count(*)::int AS n FROM pulse.metric_series WHERE base_id=${baseId}::uuid`;
    if (Number(count?.n) > Number(limits.max_series))
      throw err.badInput(`Metric "${newSeries?.name ?? batch.metrics[0]?.name}" exceeds the base limit of ${limits.max_series} series`);
  }
  if (batch.events.length) {
    const [newKind] = await db<{ kind: string }[]>`SELECT i.kind
      FROM jsonb_to_recordset((${JSON.stringify(batch.events)}::jsonb #>> '{}')::jsonb) AS i(kind text)
      WHERE NOT EXISTS(SELECT 1 FROM pulse.event_kinds k WHERE k.base_id=${baseId}::uuid AND k.kind=i.kind) LIMIT 1`;
    await db`INSERT INTO pulse.event_kinds(base_id,kind,first_seen_at,last_seen_at)
      SELECT ${baseId}::uuid,kind,${now}::timestamptz,${now}::timestamptz FROM jsonb_to_recordset((${JSON.stringify(batch.events)}::jsonb #>> '{}')::jsonb) AS i(kind text,ts timestamptz) GROUP BY kind
      ON CONFLICT(base_id,kind) DO UPDATE SET last_seen_at=greatest(pulse.event_kinds.last_seen_at,EXCLUDED.last_seen_at)`;
    const [count] = await db`SELECT count(*)::int AS n FROM pulse.event_kinds WHERE base_id=${baseId}::uuid`;
    if (Number(count?.n) > Number(limits.max_event_kinds))
      throw err.badInput(
        `Event kind "${newKind?.kind ?? batch.events[0]?.kind}" exceeds the base limit of ${limits.max_event_kinds} event kinds`,
      );
  }
  if (batch.states.length) {
    const inserted = await db<{ state_key: string }[]>`INSERT INTO pulse.state_keys(base_id,state_key,first_seen_at)
      SELECT ${baseId}::uuid,key,${now}::timestamptz FROM jsonb_to_recordset((${JSON.stringify(batch.states)}::jsonb #>> '{}')::jsonb) AS i(key text,ts timestamptz) GROUP BY key
      ON CONFLICT(base_id,state_key) DO NOTHING RETURNING state_key`;
    const [count] = await db`SELECT count(*)::int AS n FROM pulse.state_keys WHERE base_id=${baseId}::uuid`;
    if (Number(count?.n) > Number(limits.max_state_keys))
      throw err.badInput(
        `State key "${inserted[0]?.state_key ?? batch.states[0]?.key}" exceeds the base limit of ${limits.max_state_keys} state keys`,
      );
  }
  const series = await loadBatchSeries(baseId, batch, db);
  const seriesByKey = new Map(series.map((s) => [JSON.stringify([s.name, s.series_key]), s]));
  const touched = batch.metrics.map((m) => m.ts);
  const late = batch.metrics.flatMap((m) => {
    const s = seriesByKey.get(JSON.stringify([m.name, m.seriesKey]));
    if (!s?.last_sample_at || Date.parse(m.ts) >= s.last_sample_at.getTime()) return [];
    // The newest sample may still be in another T2 and invisible to the ASOF lookup.
    touched.push(s.last_sample_at.toISOString());
    return [{ series_id: s.id, ts: m.ts }];
  });
  // Commit the high-water mark in T1: ClickHouse samples survive a later T2 rollback.
  // Compare against the previous mark above; an ahead-of-store mark only adds a bounded lookup.
  if (batch.metrics.length)
    await db`UPDATE pulse.metric_series s SET last_sample_at=greatest(s.last_sample_at,i.ts)
    FROM (SELECT name,"seriesKey",max(ts) AS ts FROM jsonb_to_recordset((${JSON.stringify(batch.metrics)}::jsonb #>> '{}')::jsonb) AS i(name text,"seriesKey" text,ts timestamptz) GROUP BY name,"seriesKey") i,pulse.metric_defs d
    WHERE d.base_id=${baseId}::uuid AND d.name=i.name AND s.metric_id=d.id AND s.series_key=i."seriesKey"`;
  if (late.length) {
    const database = assertStoreName(params.database, store.prefix);
    // ASOF chooses the next observation across empty hours, at most one row per pair in each bounded request.
    for (let offset = 0; offset < late.length; offset += CLICKHOUSE_UUID_CHUNK_SIZE) {
      const chunk = late.slice(offset, offset + CLICKHOUSE_UUID_CHUNK_SIZE);
      const next = await store.query(
        `SELECT toUnixTimestamp64Milli(r.ts) AS next_ms FROM
      (SELECT pair.1 AS series_id,fromUnixTimestamp64Milli(pair.2) AS ts
       FROM (SELECT arrayJoin(arrayZip({series:Array(UUID)},{times:Array(Int64)})) AS pair) ORDER BY series_id,ts) l
      ASOF LEFT JOIN (SELECT DISTINCT series_id,ts FROM ${database}._samples
        WHERE series_id IN {series:Array(UUID)} AND ts>fromUnixTimestamp64Milli({minTime:Int64})
        AND ts>=fromUnixTimestamp64Milli({cutoff:Int64}) ORDER BY series_id,ts) r
      ON l.series_id=r.series_id AND l.ts<r.ts WHERE r.ts>l.ts`,
        {
          series: `[${chunk.map((s) => `'${s.series_id}'`).join(",")}]`,
          times: JSON.stringify(chunk.map((s) => Date.parse(s.ts))),
          minTime: Math.min(...chunk.map((s) => Date.parse(s.ts))),
          cutoff: now.getTime() - Number(limits.retention_days) * 86_400_000,
        },
      );
      touched.push(...next.map((r) => new Date(Number(r.next_ms)).toISOString()));
    }
  }
  await markMetricHoursDirty(baseId, touched, db, now);
};

export const insertStoreRows = async (store: IngestStore, database: string, table: string, rows: readonly Record<string, unknown>[]) => {
  if (!rows.length) return;
  // One bounded synchronous HTTP request per collection; never depend on insert deduplication.
  await store.query(
    `INSERT INTO ${assertStoreName(database, store.prefix)}.${table} FORMAT JSONEachRow\n${rows.map((r) => JSON.stringify(r)).join("\n")}`,
  );
};
export const clickhouseTime = (iso: string) => iso.replace("T", " ").replace("Z", "");

// One entry per accepted input state; bounded by the external/internal batch limits.
export type PlannedStates = {
  state_key: string;
  variant_key: string;
  value: string;
  dimensions: string;
  resource_key: string;
  source_id: string;
  version: string;
  updated_at: string;
  changed_at: string;
  change_id: string | null;
}[];

/** T1 commits the exact state decisions and registry before any external insert. */
export const planIngestStates = async (
  baseId: string,
  sourceId: string,
  batch: PreparedIngestBatch,
  db: PulseSqlClient,
): Promise<PlannedStates> => {
  await lockStateIdentities(
    baseId,
    batch.states.map((s) => ({ key: s.key, variantKey: s.variantKey })),
    db,
  );
  const prior = batch.states.length
    ? await db<
        {
          state_key: string;
          variant_key: string;
          updated_at: Date;
          value_hash: string;
          version: string;
          pending_change_id: string | null;
          pending_change_at: Date | null;
        }[]
      >`
    SELECT v.*,v.version::text AS version FROM pulse.state_variants v JOIN
    (SELECT DISTINCT key,"variantKey" FROM jsonb_to_recordset((${JSON.stringify(batch.states)}::jsonb #>> '{}')::jsonb) AS i(key text,"variantKey" text)) i
    ON v.state_key=i.key AND v.variant_key=i."variantKey" WHERE v.base_id=${baseId}::uuid`
    : [];
  const current = new Map(
    prior.map((s) => [
      JSON.stringify([s.state_key, s.variant_key]),
      {
        ts: s.updated_at.toISOString(),
        hash: s.value_hash,
        version: s.version,
        pendingChangeId: s.pending_change_id,
        pendingChangeAt: s.pending_change_at?.toISOString() ?? null,
      },
    ]),
  );
  const planned: PlannedStates = [];
  const updates = new Map<
    string,
    {
      key: string;
      variantKey: string;
      ts: string;
      hash: string;
      version: string;
      pendingChangeId: string | null;
      pendingChangeAt: string | null;
    }
  >();
  const plannedChanges = new Set<string>();
  // Plan transitions in time order (acceptance order on equal timestamps), so an earlier observation sent after a
  // later one in the same batch still records its value and the change that follows it.
  const chronological = [...batch.states].sort((a, b) =>
    a.ts === b.ts ? (BigInt(a.version) < BigInt(b.version) ? -1 : 1) : a.ts < b.ts ? -1 : 1,
  );
  for (const s of chronological) {
    const key = JSON.stringify([s.key, s.variantKey]),
      prev = current.get(key),
      hash = valueHash(s.value);
    if (prev && (s.ts < prev.ts || (s.ts === prev.ts && BigInt(s.version) < BigInt(prev.version)))) continue;
    const row = {
      state_key: s.key,
      variant_key: s.variantKey,
      value: JSON.stringify(s.value),
      dimensions: JSON.stringify(s.dimensions),
      resource_key: s.resourceKey ?? "",
      source_id: sourceId,
      version: s.version,
    };
    const pendingChangeId = !prev || prev.hash !== hash ? s.id : prev.pendingChangeId;
    const pendingChangeAt = !prev || prev.hash !== hash ? s.ts : prev.pendingChangeAt;
    planned.push({
      ...row,
      updated_at: clickhouseTime(s.ts),
      // Replays retain the original change time as part of the history ordering key.
      changed_at: clickhouseTime(pendingChangeAt ?? s.ts),
      change_id: pendingChangeId && !plannedChanges.has(pendingChangeId) ? pendingChangeId : null,
    });
    if (pendingChangeId) plannedChanges.add(pendingChangeId);
    current.set(key, { ts: s.ts, hash, version: s.version, pendingChangeId, pendingChangeAt });
    updates.set(key, { key: s.key, variantKey: s.variantKey, ts: s.ts, hash, version: s.version, pendingChangeId, pendingChangeAt });
  }
  if (updates.size)
    await db`INSERT INTO pulse.state_variants(base_id,state_key,variant_key,updated_at,value_hash,version,pending_change_id,pending_change_at)
    SELECT ${baseId}::uuid,key,"variantKey",ts,hash,version,"pendingChangeId","pendingChangeAt" FROM jsonb_to_recordset((${JSON.stringify([...updates.values()])}::jsonb #>> '{}')::jsonb) AS i(key text,"variantKey" text,ts timestamptz,hash text,version bigint,"pendingChangeId" uuid,"pendingChangeAt" timestamptz)
    ON CONFLICT(base_id,state_key,variant_key) DO UPDATE SET updated_at=EXCLUDED.updated_at,value_hash=EXCLUDED.value_hash,version=EXCLUDED.version,pending_change_id=EXCLUDED.pending_change_id,pending_change_at=EXCLUDED.pending_change_at`;
  return planned;
};

/** T2 holds lifecycle/source locks through all inserts and replays the committed state plan. */
export const writePreparedIngestBatchInTransaction = async (params: {
  baseId: string;
  sourceId: string;
  database: string;
  batch: PreparedIngestBatch;
  plannedStates: PlannedStates;
  db: PulseSqlClient;
  store: IngestStore;
  now: Date;
}) => {
  const { baseId, sourceId, batch, plannedStates, db, store, now, database } = params;
  const series = await loadBatchSeries(baseId, batch, db),
    byKey = new Map(series.map((s) => [JSON.stringify([s.name, s.series_key]), s]));
  await insertStoreRows(
    store,
    database,
    "_series",
    series
      .filter((s) => !s.mirrored)
      .map((s) => ({
        series_id: s.id,
        metric: s.name,
        type: s.type,
        unit: s.unit ?? "",
        source_id: s.source_id,
        resource_key: s.resource_key ?? "",
        resource_type: s.resource_type ?? "",
        resource_id: s.resource_id ?? "",
        dimensions: JSON.stringify(s.dimensions),
        version: batch.metrics[0]?.version,
      })),
  );
  await insertStoreRows(
    store,
    database,
    "_samples",
    batch.metrics.map((m) => {
      const series = byKey.get(JSON.stringify([m.name, m.seriesKey]));
      if (!series) throw new Error("Missing metric registry entry");
      return { row_id: m.id, series_id: series.id, ts: clickhouseTime(m.ts), value: m.value, version: m.version };
    }),
  );
  await insertStoreRows(
    store,
    database,
    "_events",
    batch.events.map((e) => ({
      id: e.id,
      ts: clickhouseTime(e.ts),
      kind: e.kind,
      source_id: sourceId,
      value: e.value,
      actor_id: e.actorId,
      session_id: e.sessionId,
      correlation_id: e.correlationId,
      resource_key: e.resourceKey ?? "",
      resource_type: e.resourceType ?? "",
      resource_id: e.resourceId ?? "",
      dimensions: JSON.stringify(e.dimensions),
      attributes: JSON.stringify(e.attributes),
      sensitive: JSON.stringify(e.sensitive),
      payload: JSON.stringify(e.payload),
      version: e.version,
    })),
  );
  await insertStoreRows(
    store,
    database,
    "_states_current",
    plannedStates.map(({ change_id, changed_at, ...row }) => row),
  );
  await insertStoreRows(
    store,
    database,
    "_state_changes",
    plannedStates.flatMap(({ change_id, changed_at, updated_at, ...row }) =>
      change_id ? [{ ...row, id: change_id, changed_at: changed_at ?? updated_at }] : [],
    ),
  );
  if (batch.metrics.length)
    await db`UPDATE pulse.metric_series s SET mirrored=true,last_seen_at=greatest(s.last_seen_at,${now}::timestamptz)
    FROM (SELECT DISTINCT name,"seriesKey" FROM jsonb_to_recordset((${JSON.stringify(batch.metrics)}::jsonb #>> '{}')::jsonb) AS i(name text,"seriesKey" text)) i,pulse.metric_defs d
    WHERE d.base_id=${baseId}::uuid AND d.name=i.name AND s.metric_id=d.id AND s.series_key=i."seriesKey"`;
  const maxTs = [...batch.metrics, ...batch.events, ...batch.states].reduce((max, s) => (s.ts > max ? s.ts : max), "");
  await db`UPDATE pulse.sources SET last_seen_at=${now}::timestamptz,last_data_at=greatest(last_data_at,${maxTs}::timestamptz),updated_at=greatest(updated_at,${now}::timestamptz) WHERE id=${sourceId}::uuid`;
};
