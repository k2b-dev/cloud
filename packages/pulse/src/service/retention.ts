import { sql } from "bun";
import { assertStoreName } from "../store/base-schema";
import { baseStore } from "../store/base-store";
import { CLICKHOUSE_UUID_CHUNK_SIZE } from "../store/client";
import { dropExpiredRawPartition } from "../store/maintenance";
import { requireBaseWritable } from "./access-control";
import type { IngestStore } from "./ingest-bulk";

const DAY_MS = 86_400_000;
const BATCH = 50_000;
export type RetentionResult = {
  phase: "seal" | "partition" | "registries" | "done";
  sealedHours: number;
  rawPartitions: number;
  idempotencyRecords: number;
  registryRecords: number;
  scrapeRecords: number;
  hourRecords: number;
  done: boolean;
  nextAfter: string | null;
};

export const createRetention =
  ({
    store: configuredStore = baseStore,
    database = sql,
    clock = configuredStore.clock,
  }: {
    store?: IngestStore;
    database?: typeof sql;
    clock?: () => Date;
  } = {}) =>
  async (baseId?: string, after: string | null = null): Promise<RetentionResult> => {
    const store = { ...configuredStore, query: await configuredStore.prepare() };
    const now = clock();
    const result: RetentionResult = {
      phase: "done",
      sealedHours: 0,
      rawPartitions: 0,
      idempotencyRecords: 0,
      registryRecords: 0,
      scrapeRecords: 0,
      hourRecords: 0,
      done: true,
      nextAfter: null,
    };
    // One base and one raw partition per run. The job carries its cursor across bounded runs.
    const bases = await database<{ id: string }[]>`SELECT b.id FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id
      WHERE s.state='active' AND s.write_block_reason IS NULL AND (${baseId ?? null}::uuid IS NULL OR b.id=${baseId ?? null}::uuid) AND (${after}::uuid IS NULL OR b.id>${after}::uuid) ORDER BY b.id LIMIT 1`;
    for (const base of bases) {
      // Commit seals, their pruning watermark, and retirement intent before irreversible ClickHouse effects.
      // A later rollback must neither reopen dropped raw hours nor acknowledge tombstoned identities.
      const retiring = await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        await tx`SELECT id FROM pulse.bases WHERE id=${base.id}::uuid FOR UPDATE`;
        const active = await requireBaseWritable(base.id, tx);
        if (!active.ok) return [];
        const [b] = await tx<{ retention_days: number; rollup_retention_days: number }[]>`
          SELECT retention_days,rollup_retention_days FROM pulse.bases WHERE id=${base.id}::uuid`;
        if (!b) return [];
        const rawCutoff = new Date(now.getTime() - b.retention_days * DAY_MS),
          registryCutoff = new Date(now.getTime() - Math.max(b.retention_days, b.rollup_retention_days) * DAY_MS);
        // A pending keyed batch may still replay metrics back to its own acceptance time minus raw retention, and
        // keeps that promise for the key's lifetime: hold the seal horizon there until the key is done or expired.
        const [pending] = await tx<{ oldest: Date | null }[]>`SELECT min(i.accepted_at) AS oldest FROM pulse.ingest_idempotency i
          JOIN pulse.sources src ON src.id=i.source_id WHERE src.base_id=${base.id}::uuid AND i.state='pending' AND i.expires_at>${now}`;
        const sealCutoff = new Date(
          Math.min(rawCutoff.getTime(), pending?.oldest ? pending.oldest.getTime() - b.retention_days * DAY_MS : Number.POSITIVE_INFINITY),
        );
        const sealed = await tx`WITH victims AS(SELECT hour FROM pulse.metric_hours WHERE base_id=${base.id}::uuid AND state='clean'
          AND hour+interval '1 hour'<=${sealCutoff} AND (lease_until IS NULL OR lease_until<=${now}) ORDER BY hour LIMIT ${BATCH} FOR UPDATE)
          UPDATE pulse.metric_hours h SET state='sealed',updated_at=${now} FROM victims v WHERE h.base_id=${base.id}::uuid AND h.hour=v.hour AND h.state='clean'`;
        result.sealedHours += sealed.count;
        // Preserve the seal before discarding its individual rows. Do not advance past an outstanding
        // dirty/clean hour, even when it predates a sealed one, nor past the pending replay horizon.
        await tx`UPDATE pulse.base_stores SET sealed_before=greatest(sealed_before,
          (SELECT max(hour)+interval '1 hour' FROM pulse.metric_hours h WHERE h.base_id=${base.id}::uuid
            AND state='sealed' AND hour+interval '1 hour'<=least(${registryCutoff}::timestamptz,${sealCutoff}::timestamptz)
            AND hour<coalesce((SELECT min(hour) FROM pulse.metric_hours WHERE base_id=${base.id}::uuid AND state<>'sealed'),'infinity'::timestamptz)))
          WHERE base_id=${base.id}::uuid`;
        if (sealed.count >= BATCH) result.done = false;
        return tx<{ id: string }[]>`WITH victims AS (
          SELECT s.id FROM pulse.metric_series s JOIN pulse.bases b ON b.id=s.base_id
          WHERE s.base_id=${base.id}::uuid
            AND coalesce(s.last_seen_at,s.created_at)<${now}::timestamptz-greatest(b.retention_days,b.rollup_retention_days)*interval '1 day'
            AND (s.last_sample_at IS NULL OR s.last_sample_at<${now}::timestamptz-greatest(b.retention_days,b.rollup_retention_days)*interval '1 day')
          ORDER BY s.id LIMIT ${BATCH} FOR UPDATE OF s)
          UPDATE pulse.metric_series s SET mirrored=false FROM victims v WHERE s.id=v.id RETURNING s.id`;
      });
      await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        // Pruning must exclude T1 reservations and in-flight T2 inserts, just like clear/delete.
        await tx`SELECT id FROM pulse.bases WHERE id=${base.id}::uuid FOR UPDATE`;
        const active = await requireBaseWritable(base.id, tx);
        if (!active.ok) return;
        const [b] = await tx<{ database_name: string; retention_days: number; rollup_retention_days: number }[]>`
          SELECT s.database_name,b.retention_days,b.rollup_retention_days FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id WHERE b.id=${base.id}::uuid`;
        if (!b) return;
        const rawCutoff = new Date(now.getTime() - b.retention_days * DAY_MS),
          registryCutoff = new Date(now.getTime() - Math.max(b.retention_days, b.rollup_retention_days) * DAY_MS);
        if (await dropExpiredRawPartition({ baseId: base.id, databaseName: b.database_name, cutoff: rawCutoff, store, db: tx })) {
          result.rawPartitions++;
          result.done = false;
        }
        const keys =
          await tx`WITH victims AS(SELECT i.source_id,i.idempotency_key FROM pulse.ingest_idempotency i JOIN pulse.sources s ON s.id=i.source_id WHERE s.base_id=${base.id}::uuid AND i.expires_at<=${now} LIMIT ${BATCH})
          DELETE FROM pulse.ingest_idempotency i USING victims v WHERE i.source_id=v.source_id AND i.idempotency_key=v.idempotency_key`;
        result.idempotencyRecords += keys.count;
        const scrapes =
          await tx`WITH victims AS(SELECT id FROM pulse.source_scrapes WHERE base_id=${base.id}::uuid AND started_at<${rawCutoff} LIMIT ${BATCH}) DELETE FROM pulse.source_scrapes s USING victims v WHERE s.id=v.id`;
        result.scrapeRecords += scrapes.count;
        const hours = await tx`WITH victims AS(SELECT hour FROM pulse.metric_hours WHERE base_id=${base.id}::uuid AND state='sealed'
            AND hour<(SELECT sealed_before FROM pulse.base_stores WHERE base_id=${base.id}::uuid) LIMIT ${BATCH})
          DELETE FROM pulse.metric_hours h USING victims v WHERE h.base_id=${base.id}::uuid AND h.hour=v.hour`;
        result.hourRecords += hours.count;
        // Recheck under the lifecycle lock: an ingest between the intent and this transaction may have revived a victim.
        const expiredSeries = await tx<{ id: string }[]>`SELECT id FROM pulse.metric_series
          WHERE base_id=${base.id}::uuid AND id=ANY(${sql.array(
            retiring.map((s) => s.id),
            "UUID",
          )})
          AND coalesce(last_seen_at,created_at)<${registryCutoff}
          AND (last_sample_at IS NULL OR last_sample_at<${registryCutoff}) ORDER BY id LIMIT ${BATCH} FOR UPDATE`;
        const seriesIds = expiredSeries.map((s) => s.id);
        for (let offset = 0; offset < seriesIds.length; offset += CLICKHOUSE_UUID_CHUNK_SIZE) {
          const chunk = seriesIds.slice(offset, offset + CLICKHOUSE_UUID_CHUNK_SIZE);
          const database = assertStoreName(b.database_name, store.prefix);
          // FINAL keeps the current mirror. A strictly higher version wins before and after merges,
          // including retries after the ClickHouse insert succeeded but the SQL transaction failed.
          await store.query(
            `INSERT INTO ${database}._series (series_id,metric,type,unit,source_id,resource_key,resource_type,resource_id,dimensions,version,deleted)
            SELECT series_id,metric,type,unit,source_id,resource_key,resource_type,resource_id,dimensions,version+1,toUInt8(1)
            FROM ${database}._series FINAL WHERE series_id IN {series:Array(UUID)}`,
            { series: `[${chunk.map((id) => `'${id}'`).join(",")}]` },
          );
        }
        const series = await tx`DELETE FROM pulse.metric_series WHERE id=ANY(${sql.array(seriesIds, "UUID")})`;
        const defs =
          await tx`WITH victims AS(SELECT id FROM pulse.metric_defs d WHERE base_id=${base.id}::uuid AND NOT EXISTS(SELECT 1 FROM pulse.metric_series s WHERE s.metric_id=d.id) LIMIT ${BATCH}) DELETE FROM pulse.metric_defs d USING victims v WHERE d.id=v.id`;
        const kinds =
          await tx`WITH victims AS(SELECT kind FROM pulse.event_kinds WHERE base_id=${base.id}::uuid AND last_seen_at<${registryCutoff} LIMIT ${BATCH}) DELETE FROM pulse.event_kinds k USING victims v WHERE k.base_id=${base.id}::uuid AND k.kind=v.kind`;
        const states =
          await tx`WITH victims AS(SELECT state_key FROM pulse.state_keys k WHERE base_id=${base.id}::uuid AND first_seen_at<${registryCutoff} AND NOT EXISTS(SELECT 1 FROM pulse.state_variants v WHERE v.base_id=k.base_id AND v.state_key=k.state_key) LIMIT ${BATCH})
          DELETE FROM pulse.state_keys k USING victims v WHERE k.base_id=${base.id}::uuid AND k.state_key=v.state_key`;
        result.registryRecords += series.count + defs.count + kinds.count + states.count;
        if (retiring.length >= BATCH || [keys, scrapes, hours, series, defs, kinds, states].some((r) => r.count >= BATCH))
          result.done = false;
      });
    }
    if (!baseId && bases[0]) {
      result.nextAfter = result.done ? bases[0].id : after;
      result.done = false;
    }
    result.phase = result.rawPartitions
      ? "partition"
      : result.sealedHours
        ? "seal"
        : result.registryRecords || result.idempotencyRecords || result.scrapeRecords || result.hourRecords
          ? "registries"
          : "done";
    return result;
  };
export const runRetentionBatch = createRetention();
