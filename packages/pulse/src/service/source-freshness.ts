import { sql } from "bun";
import { recordBaseActivity } from "./base-activity";
import { enqueueBaseNotice } from "./base-notifications";
import { type FreshnessSource, sourceStaleSince } from "./source-staleness";
import { iso, isoNullable } from "./telemetry-values";

/** Control metadata only: checking freshness never prepares or queries ClickHouse.
 * A base lock serializes lifecycle/configuration and replica workers. The source
 * cursor advances in the same short transaction as the state and its outbox. */
export const checkSourceFreshnessBatch = async (locale: string, now: Date, database = sql): Promise<number> =>
  database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout='10s'`.simple();
    const [base] = await tx<{ id: string; short_id: string; name: string; timezone: string }[]>`
      SELECT b.id,b.short_id,b.name,b.timezone FROM pulse.bases b
      WHERE b.deletion_started_at IS NULL AND EXISTS(SELECT 1 FROM pulse.base_stores st WHERE st.base_id=b.id AND st.state='active')
        AND EXISTS(SELECT 1 FROM pulse.sources s WHERE s.base_id=b.id AND NOT s.deleted AND s.next_freshness_check_at<=${now})
      ORDER BY (SELECT min(s.next_freshness_check_at) FROM pulse.sources s WHERE s.base_id=b.id AND NOT s.deleted),b.id
      LIMIT 1 FOR UPDATE OF b SKIP LOCKED`;
    if (!base) return 0;
    const sources = await tx<
      {
        id: string;
        short_id: string;
        name: string;
        kind: FreshnessSource["kind"];
        enabled: boolean;
        scrape_interval_seconds: number | null;
        expect_every_seconds: number | null;
        expect_daily_by: string | null;
        last_data_at: Date | string | null;
        created_at: Date | string;
        stale_since: Date | string | null;
      }[]
    >`SELECT * FROM pulse.sources WHERE base_id=${base.id}::uuid AND NOT deleted AND next_freshness_check_at<=${now}
      ORDER BY next_freshness_check_at,id LIMIT 100 FOR UPDATE`;
    for (const row of sources) {
      const newestDataAt = isoNullable(row.last_data_at);
      const missedDeadline = sourceStaleSince(
        {
          kind: row.kind,
          enabled: row.enabled,
          scrapeIntervalSeconds: row.scrape_interval_seconds,
          expectEverySeconds: row.expect_every_seconds,
          expectDailyBy: row.expect_daily_by,
          newestDataAt,
          createdAt: iso(row.created_at),
        },
        base.timezone,
        now,
      );
      const staleSince = missedDeadline === null ? null : (isoNullable(row.stale_since) ?? missedDeadline);
      await tx`UPDATE pulse.sources SET stale_since=${staleSince}::timestamptz,next_freshness_check_at=${new Date(now.getTime() + 60_000)}
        WHERE id=${row.id}::uuid`;
      if ((row.stale_since !== null) === (staleSince !== null)) continue;
      const data = {
        baseId: base.short_id,
        baseName: base.name,
        sourceId: row.short_id,
        sourceName: row.name,
        stale: staleSince !== null,
        newestDataAt,
      };
      await enqueueBaseNotice(tx, base.id, { kind: "source_stale", data }, locale);
      await recordBaseActivity(tx, { baseId: base.id, kind: "source_freshness", data, at: now });
    }
    return sources.length;
  });

export const checkSourceFreshness = async (locale: string, input: { now?: Date; signal?: AbortSignal; heartbeat?: () => void } = {}) => {
  const now = input.now ?? new Date();
  const deadline = performance.now() + 50_000;
  let checked = 0;
  // Same bounded per-minute scheduling model as alert evaluation, with 100
  // sources per transaction and no external effects inside the transaction.
  for (let page = 0; page < 20 && performance.now() < deadline && !input.signal?.aborted; page++) {
    input.heartbeat?.();
    const count = await checkSourceFreshnessBatch(locale, now);
    checked += count;
    if (!count) break;
  }
  return { checked };
};
