import { sql } from "bun";

// Metadata is retained while any durable observation still needs it. The base's
// exclusive lock prevents an ingest from attaching new samples after our snapshot.
const victims = (baseId: string | null) => sql`
 SELECT b.id AS base_id,'series' AS kind,s.id::text AS key
 FROM pulse.bases b JOIN pulse.metric_series s ON s.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid)
   AND s.last_seen_at<now()-b.retention_days*interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_samples r WHERE r.series_id=s.id)
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_rollups_hourly r WHERE r.series_id=s.id)
 UNION ALL
 SELECT b.id,'definition',d.id::text FROM pulse.bases b JOIN pulse.metric_defs d ON d.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid)
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_series s WHERE s.metric_id=d.id)
 UNION ALL
 SELECT b.id,'resource',r.resource_key FROM pulse.bases b JOIN pulse.observed_resources r ON r.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid)
   AND r.last_seen_at<now()-b.retention_days*interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_series s WHERE s.base_id=b.id AND s.resource_key=r.resource_key)
   AND NOT EXISTS(SELECT 1 FROM pulse.states_current s WHERE s.base_id=b.id AND s.resource_key=r.resource_key)
   AND NOT EXISTS(SELECT 1 FROM pulse.events e WHERE e.base_id=b.id AND e.resource_key=r.resource_key)
 UNION ALL
 SELECT b.id,'scrape',s.id::text FROM pulse.bases b JOIN pulse.source_scrapes s ON s.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid) AND s.started_at<now()-b.retention_days*interval '1 day'
 UNION ALL
 SELECT b.id,'hour',h.hour::text FROM pulse.bases b JOIN pulse.metric_hours h ON h.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid) AND h.state='sealed'
   AND h.hour<date_bin('1 hour',now()-greatest(b.retention_days,b.rollup_retention_days)*interval '1 day','1970-01-01'::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_samples s WHERE s.base_id=b.id AND s.ts>=h.hour AND s.ts<h.hour+interval '1 hour')
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_rollups_hourly r WHERE r.base_id=b.id AND r.bucket=h.hour)
 UNION ALL
 SELECT b.id,'field',f.ctid::text FROM pulse.bases b JOIN pulse.signal_fields f ON f.base_id=b.id
 WHERE (${baseId}::uuid IS NULL OR b.id=${baseId}::uuid) AND f.last_seen_at<now()-b.retention_days*interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM pulse.metric_series s JOIN pulse.metric_defs d ON d.id=s.metric_id
     WHERE f.scope='metric' AND s.base_id=b.id AND s.source_id=f.source_id AND d.name=f.signal_name)
   AND NOT EXISTS(SELECT 1 FROM pulse.states_current s WHERE f.scope='state' AND s.base_id=b.id AND s.source_id=f.source_id AND s.state_key=f.signal_name)
   AND NOT EXISTS(SELECT 1 FROM pulse.events e WHERE f.scope='event' AND e.base_id=b.id AND e.source_id=f.source_id AND e.kind=f.signal_name)
`;

export const pruneCatalogBatch = async (baseId: string | undefined, limit: number): Promise<number> =>
  sql.begin(async (tx) => {
    const [candidate] = await tx<{ base_id: string }[]>`
   SELECT v.base_id FROM (${victims(baseId ?? null)}) v JOIN pulse.bases b ON b.id=v.base_id
   WHERE b.deletion_started_at IS NULL AND (b.data_clear_started_at IS NULL OR b.data_clear_completed_at IS NOT NULL)
   LIMIT 1`;
    if (!candidate) return 0;
    const [base] = await tx`SELECT id FROM pulse.bases WHERE id=${candidate.base_id}::uuid
   AND deletion_started_at IS NULL AND (data_clear_started_at IS NULL OR data_clear_completed_at IS NOT NULL) FOR UPDATE`;
    if (!base) return 0;
    // Re-evaluate after acquiring the writer exclusion lock, never delete from the earlier snapshot.
    const rows = await tx<{ kind: string; key: string }[]>`SELECT kind,key FROM (${victims(candidate.base_id)}) v LIMIT ${limit}`;
    const keys = (kind: string) => rows.filter((row) => row.kind === kind).map((row) => row.key);
    let count = 0;
    for (const kind of ["series", "definition", "resource", "scrape", "hour", "field"]) {
      const selected = keys(kind);
      if (!selected.length) continue;
      const set = sql`SELECT value FROM jsonb_array_elements_text((${JSON.stringify(selected)}::jsonb #>> '{}')::jsonb)`;
      const result =
        kind === "series"
          ? await tx`DELETE FROM pulse.metric_series WHERE base_id=${candidate.base_id}::uuid AND id IN (SELECT value::uuid FROM (${set}) ids)`
          : kind === "definition"
            ? await tx`DELETE FROM pulse.metric_defs WHERE base_id=${candidate.base_id}::uuid AND id IN (SELECT value::uuid FROM (${set}) ids)`
            : kind === "resource"
              ? await tx`DELETE FROM pulse.observed_resources WHERE base_id=${candidate.base_id}::uuid AND resource_key IN (${set})`
              : kind === "scrape"
                ? await tx`DELETE FROM pulse.source_scrapes WHERE base_id=${candidate.base_id}::uuid AND id IN (SELECT value::uuid FROM (${set}) ids)`
                : kind === "hour"
                  ? await tx`DELETE FROM pulse.metric_hours WHERE base_id=${candidate.base_id}::uuid AND hour IN (SELECT value::timestamptz FROM (${set}) ids)`
                  : await tx`DELETE FROM pulse.signal_fields WHERE base_id=${candidate.base_id}::uuid AND ctid IN (SELECT value::tid FROM (${set}) ids)`;
      count += result.count ?? 0;
    }
    return count;
  });
