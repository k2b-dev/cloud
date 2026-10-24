import { sql } from "bun";
import { DASHBOARD_REFRESH_MS } from "../dashboard-contracts";

// A calculation gets one durable receipt per revision/range/interval. Keeping
// receipts outside the result cache prevents eviction from refunding work.
const LEASE_MS = 60_000; // SQL admission + 30 s profile + KILL and commit reserve.
const RECEIPT_MS = 24 * 3_600_000; // Same bounded replay lifetime as Pulse writes.
type Run = {
  slot_start: Date;
  lease_id: string | null;
  lease_until: Date | null;
  finished_at: Date | null;
  failures: number;
  retry_at: Date | null;
  error_code: string | null;
};
export const createDashboardRuns = (testOnly?: { now: () => Date }) => {
  const now = async (db: typeof sql) => {
    const [row] = await db<{ at: Date }[]>`SELECT coalesce(${testOnly?.now() ?? null}::timestamptz,clock_timestamp()) AS at`;
    return row!.at;
  };
  const read = async (dashboardId: string, variant: string, db = sql) => {
    const [row] = await db<Run[]>`SELECT * FROM pulse.dashboard_runs WHERE dashboard_id=${dashboardId}::uuid AND variant=${variant}`;
    return row ?? null;
  };
  return {
    read,
    async claim(dashboardId: string, variant: string) {
      return sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='5s'`.simple();
        // The dashboard row serializes initial inserts without a process-local lock.
        const [dashboard] = await tx`SELECT id FROM pulse.dashboards WHERE id=${dashboardId}::uuid FOR UPDATE`;
        if (!dashboard) return null;
        const at = await now(tx);
        const slot = new Date(Math.floor(at.getTime() / DASHBOARD_REFRESH_MS) * DASHBOARD_REFRESH_MS);
        await tx`WITH expired AS (SELECT dashboard_id,variant FROM pulse.dashboard_runs WHERE expires_at<=${at} LIMIT 500)
          DELETE FROM pulse.dashboard_runs r USING expired e WHERE r.dashboard_id=e.dashboard_id AND r.variant=e.variant`;
        const old = await read(dashboardId, variant, tx);
        if (old && ((old.lease_until && old.lease_until > at) || (old.retry_at && old.retry_at > at) || old.slot_start >= slot))
          return null;
        if (old?.lease_id && !old.finished_at) {
          // A crashed worker is a failed calculation. Record its backoff before
          // allowing another replica to start, just as for an explicit error.
          await tx`UPDATE pulse.dashboard_runs SET lease_id=NULL,lease_until=NULL,finished_at=${at},error_code='TIME_LIMIT',
            failures=failures+1,retry_at=${at}::timestamptz+make_interval(secs=>least(300,60*power(2,least(failures,3)))::double precision)
            WHERE dashboard_id=${dashboardId}::uuid AND variant=${variant}`;
          return null;
        }
        const leaseId = crypto.randomUUID();
        const failures = old ? old.failures + (old.lease_id && !old.finished_at ? 1 : 0) : 0;
        await tx`INSERT INTO pulse.dashboard_runs(dashboard_id,variant,slot_start,lease_id,lease_until,failures,expires_at)
          VALUES(${dashboardId}::uuid,${variant},${slot},${leaseId}::uuid,${new Date(at.getTime() + LEASE_MS)},${failures},${new Date(at.getTime() + RECEIPT_MS)})
          ON CONFLICT(dashboard_id,variant) DO UPDATE SET slot_start=EXCLUDED.slot_start,lease_id=EXCLUDED.lease_id,
            lease_until=EXCLUDED.lease_until,finished_at=NULL,failures=EXCLUDED.failures,error_code=NULL,retry_at=NULL,expires_at=EXCLUDED.expires_at`;
        return { leaseId, slot: slot.toISOString(), startedAt: at.toISOString() };
      });
    },
    async finish(dashboardId: string, variant: string, leaseId: string, errorCode: string | null) {
      return sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='5s'`.simple();
        const at = await now(tx);
        const rows = await tx`UPDATE pulse.dashboard_runs SET lease_id=NULL,lease_until=NULL,finished_at=${at},error_code=${errorCode},
          retry_at=CASE WHEN ${errorCode}::text IS NULL THEN NULL ELSE ${at}::timestamptz+make_interval(secs=>least(300,60*power(2,least(failures,3)))::double precision) END,
          failures=CASE WHEN ${errorCode}::text IS NULL THEN 0 ELSE failures+1 END
          WHERE dashboard_id=${dashboardId}::uuid AND variant=${variant} AND lease_id=${leaseId}::uuid AND lease_until>${at} RETURNING dashboard_id`;
        return rows.length === 1;
      });
    },
  };
};
export const dashboardRuns = createDashboardRuns();
