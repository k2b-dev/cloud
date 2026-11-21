import { redis as platformRedis, sql } from "@k2b/cloud";
import type { RedisClient } from "bun";
import type { PulseSourceRejections } from "../contracts";
import { REJECTION_REASON_MAX_LENGTH } from "./source-rejection-reason";
import { isoNullable } from "./telemetry-values";

// Valkey holds ingest refusals per source and minute (source-rejection-recorder.ts).
// The flush job copies them here every five minutes; buckets outlive several missed runs.
export const REJECTION_BUCKET_TTL_MS = 2 * 3_600_000;
export const REJECTION_NAMESPACE = "pulse:{rejections}";
export const rejectionIndexKey = (namespace: string) => `${namespace}:index`;
export const rejectionBucketKey = (namespace: string, member: string) => `${namespace}:${member}`;

export const REJECTION_FLUSH_BATCH_SIZE = 500;
/** Twenty batches cover 10,000 source minutes per five-minute run. */
export const REJECTION_FLUSH_MAX_BATCHES = 20;
export const REJECTION_RETENTION_DAYS = 7;
const REJECTION_RETENTION_DELETE_LIMIT = 10_000;
/** A minute bucket is final one minute after it ends; the extra minute absorbs replica clock skew. */
const BUCKET_FINAL_AFTER_MS = 2 * 60_000;

export const EMPTY_SOURCE_REJECTIONS: PulseSourceRejections = { last24h: 0, lastReason: null, lastAt: null };

/** Valkey replies are untyped; keep string entries and turn anything else into a missing value. */
const strings = (reply: unknown): (string | null)[] =>
  Array.isArray(reply) ? reply.map((entry) => (typeof entry === "string" ? entry : null)) : [];

type BucketRow = { short_id: string; minute: string; count: number; reason: string; at: string };

/**
 * Copies Valkey rejection buckets to `pulse.source_rejections`. Buckets are never consumed:
 * a bucket's count only grows, so writing the larger count makes a repeated or overlapping
 * run idempotent, and a failed Postgres write leaves every bucket for the next run.
 * Final buckets leave the index after they are stored; Valkey expires them on its own.
 */
export const flushSourceRejections = async ({
  redis = platformRedis,
  db = sql,
  now = new Date(),
  namespace = REJECTION_NAMESPACE,
  batchSize = REJECTION_FLUSH_BATCH_SIZE,
}: {
  redis?: Pick<RedisClient, "send">;
  db?: typeof sql;
  now?: Date;
  namespace?: string;
  batchSize?: number;
} = {}): Promise<{ buckets: number; stored: number; pruned: number }> => {
  const index = rejectionIndexKey(namespace);
  let buckets = 0;
  let stored = 0;
  for (let batch = 0; batch < REJECTION_FLUSH_MAX_BATCHES; batch++) {
    // Oldest minutes first; open minutes stay in the index and are rewritten by later runs.
    const members = strings(await redis.send("ZRANGE", [index, "0", String(batchSize - 1)])).filter(
      (member): member is string => member !== null,
    );
    if (!members.length) break;
    const values = await Promise.all(
      members.map(async (member) => strings(await redis.send("HMGET", [rejectionBucketKey(namespace, member), "count", "reason", "at"]))),
    );
    const rows: BucketRow[] = [];
    const done: string[] = [];
    members.forEach((member, i) => {
      const separator = member.lastIndexOf(":");
      const minute = Number(member.slice(separator + 1));
      const [count, reason, at] = values[i] ?? [];
      const valid = separator > 0 && Number.isSafeInteger(minute) && Number(count) > 0 && Number.isSafeInteger(Number(count)) && at;
      if (valid)
        rows.push({
          short_id: member.slice(0, separator),
          minute: new Date(minute).toISOString(),
          count: Number(count),
          reason: reason ?? "",
          at,
        });
      // An expired or malformed bucket has nothing left to store.
      if (!valid || minute + BUCKET_FINAL_AFTER_MS <= now.getTime()) done.push(member);
    });
    buckets += rows.length;
    if (rows.length) {
      const result = await db`INSERT INTO pulse.source_rejections(source_id,minute,count,last_reason,last_at)
        SELECT s.id,i.minute,i.count,left(i.reason,${REJECTION_REASON_MAX_LENGTH}),i.at
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS i(short_id text,minute timestamptz,count int,reason text,at timestamptz)
        JOIN pulse.sources s ON s.short_id=i.short_id AND NOT s.deleted
        ON CONFLICT(source_id,minute) DO UPDATE SET count=greatest(pulse.source_rejections.count,EXCLUDED.count),
          last_reason=CASE WHEN EXCLUDED.last_at>=pulse.source_rejections.last_at THEN EXCLUDED.last_reason ELSE pulse.source_rejections.last_reason END,
          last_at=greatest(pulse.source_rejections.last_at,EXCLUDED.last_at)`;
      stored += result.count;
    }
    if (done.length) await redis.send("ZREM", [index, ...done]);
    if (members.length < batchSize || !done.length) break;
  }
  const pruned = await db`DELETE FROM pulse.source_rejections WHERE ctid=ANY(ARRAY(
    SELECT ctid FROM pulse.source_rejections WHERE minute<${new Date(now.getTime() - REJECTION_RETENTION_DAYS * 86_400_000)}
    LIMIT ${REJECTION_RETENTION_DELETE_LIMIT}))`;
  return { buckets, stored, pruned: pruned.count };
};

/** Rejections in the last 24 hours and the latest stored reason per source; one statement for a whole source page. */
export const sourceRejectionSummaries = async (
  sourceIds: string[],
  now: Date,
  db: typeof sql = sql,
): Promise<Map<string, PulseSourceRejections>> => {
  if (!sourceIds.length) return new Map();
  const rows = await db<{ source_id: string; last24h: string | number; last_reason: string | null; last_at: Date | string | null }[]>`
    SELECT s.id AS source_id, coalesce(t.total,0)::bigint AS last24h, l.last_reason, l.last_at
    FROM unnest(${sql.array(sourceIds, "UUID")}::uuid[]) AS s(id)
    -- Both reads use the (source_id, minute) key: one day of minutes to count, one newest row for the reason.
    LEFT JOIN LATERAL (SELECT sum(r.count) AS total FROM pulse.source_rejections r
      WHERE r.source_id=s.id AND r.minute>${new Date(now.getTime() - 86_400_000)}) t ON true
    LEFT JOIN LATERAL (SELECT r.last_reason,r.last_at FROM pulse.source_rejections r
      WHERE r.source_id=s.id ORDER BY r.minute DESC LIMIT 1) l ON true
    WHERE l.last_at IS NOT NULL`;
  return new Map(
    rows.map((row) => [row.source_id, { last24h: Number(row.last24h), lastReason: row.last_reason, lastAt: isoNullable(row.last_at) }]),
  );
};
