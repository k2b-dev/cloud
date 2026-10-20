import { sql } from "bun";
import type { ReadProfileName } from "../store/admin-contracts";
import { sqlRunner } from "../store/sql-run";
import { sqlAdmission } from "./sql-admission";

/** Called only after listSources has required read access. Registry counts
 * remain useful if the read store is busy; today counts are then null. */
export const sourceCounts = async (baseId: string, now: Date, signal?: AbortSignal) => {
  const series = await sql<
    { source_id: string; count: number }[]
  >`SELECT source_id,count(*)::int AS count FROM pulse.metric_series WHERE base_id=${baseId}::uuid AND source_id IS NOT NULL GROUP BY source_id`;
  const counts = new Map(series.map((row) => [row.source_id, { seriesCount: row.count, todayCount: null as number | null }]));
  let release: (() => Promise<void>) | undefined;
  try {
    const [base] = await sql<
      { database_name: string; profile: ReadProfileName; timezone: string }[]
    >`SELECT s.database_name,s.profile,b.timezone FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE s.base_id=${baseId}::uuid AND s.state='active'`;
    if (!base || signal?.aborted) return counts;
    const cacheKey = `${baseId}:${Math.floor(now.getTime() / 300000)}`;
    const cached = await sqlAdmission.cached(cacheKey);
    let today: unknown;
    if (cached) today = JSON.parse(cached);
    else {
      const runId = crypto.randomUUID();
      // Source lists never wait behind interactive questions and never consume
      // their hourly quota. One aggregate for the whole base, not per source.
      const slot = await sqlAdmission.check({ baseId, runId, quota: 0, countQuota: false });
      if (slot.state !== "OK") {
        await sqlAdmission.release(baseId, runId);
        return counts;
      }
      release = () => sqlAdmission.release(baseId, runId);
      const result = await sqlRunner.run({
        baseId,
        database: base.database_name,
        profile: base.profile,
        timezone: base.timezone,
        runId,
        signal,
        executionDeadline: slot.executionDeadline,
        sql: `SELECT source_id, sum(n) AS n FROM (SELECT s.source_id, count() AS n FROM samples AS p INNER JOIN series AS s USING(series_id) WHERE p.ts >= toStartOfDay(:at, :base_tz) GROUP BY s.source_id UNION ALL SELECT source_id, count() AS n FROM events WHERE ts >= toStartOfDay(:at, :base_tz) GROUP BY source_id UNION ALL SELECT source_id, count() AS n FROM states WHERE updated_at >= toStartOfDay(:at, :base_tz) GROUP BY source_id) GROUP BY source_id`,
        params: { at: now.toISOString() },
      });
      if (result.truncated) return counts;
      today = result.rows.map((row) => [String(row[0]), Number(row[1])]);
      await sqlAdmission.cache(cacheKey, JSON.stringify(today));
    }
    if (!Array.isArray(today)) return counts;
    // The absence of a source from a successful aggregate means zero today.
    for (const item of counts.values()) item.todayCount = 0;
    for (const entry of today)
      if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(Number(entry[1]))) {
        const previous = counts.get(entry[0]);
        counts.set(entry[0], { seriesCount: previous?.seriesCount ?? 0, todayCount: Number(entry[1]) });
      }
    // Sentinel distinguishes a successful all-empty answer from unavailable.
    counts.set("", { seriesCount: 0, todayCount: 0 });
  } catch {
    /* A busy/unavailable count must not fail the sources list. */
  } finally {
    await release?.().catch(() => {});
  }
  return counts;
};
