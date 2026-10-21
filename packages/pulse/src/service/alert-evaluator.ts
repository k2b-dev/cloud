import { sql } from "bun";
import { ALERT_MAX_KEYS, type AlertKeyState, type AlertSeverity, type AlertStateName, type AlertThresholds } from "../alert-contracts";
import { nextAlertState, readAlertValues } from "./alert-state";
import { recordBaseActivity } from "./base-activity";
import { enqueueBaseNotice, notificationLocale } from "./base-notifications";
import { CLOUD_SLOTS } from "./sql-admission";
import { runAlertSql } from "./sql-service";
import { iso, isoNullable } from "./telemetry-values";

type Claim = {
  id: string;
  short_id: string;
  base_id: string;
  name: string;
  revision: number;
  lease_id: string;
  reset_generation: number;
  comparison: AlertThresholds["comparison"];
  warn: number | null;
  critical: number | null;
  min_duration_seconds: number;
  interval_seconds: number;
  overdue: boolean;
  next_check_at: Date | string;
  claimed_at: Date;
};
type StateRow = {
  key: string;
  state: AlertStateName;
  severity: AlertSeverity | null;
  value: number | null;
  since: Date | string;
  pending_since: Date | string | null;
  incident_open: boolean;
  last_checked_at: Date | string;
  last_error: string | null;
};
const fromRow = (row: StateRow): AlertKeyState => ({
  key: row.key,
  state: row.state,
  severity: row.severity,
  value: row.value,
  since: iso(row.since),
  pendingSince: isoNullable(row.pending_since),
  incidentOpen: row.incident_open,
  lastCheckedAt: iso(row.last_checked_at),
  lastError: row.last_error,
});

/** Base then rule is the same lock order as CRUD/lifecycle. A running rule never
 * waits for admission, and only one evaluation per base is claimed at a time. */
export const claimDueAlert = async (now: Date, database = sql): Promise<Claim | null> =>
  database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout='5s'`.simple();
    const [base] = await tx<{ id: string; reset_generation: number }[]>`SELECT b.id,s.reset_generation FROM pulse.bases b
    JOIN pulse.base_stores s ON s.base_id=b.id AND s.state='active'
    WHERE b.deletion_started_at IS NULL AND EXISTS (SELECT 1 FROM pulse.alert_rules r WHERE r.base_id=b.id
      AND (r.next_check_at<=${now} OR r.lease_until<=clock_timestamp()) AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()))
      AND NOT EXISTS (SELECT 1 FROM pulse.alert_rules active WHERE active.base_id=b.id AND active.lease_until>clock_timestamp())
    ORDER BY (SELECT min(next_check_at) FROM pulse.alert_rules r WHERE r.base_id=b.id),b.id
    LIMIT 1 FOR UPDATE OF b SKIP LOCKED`;
    if (!base) return null;
    // Fresh snapshot after acquiring the base lock closes a concurrent-claim race.
    if ((await tx`SELECT 1 FROM pulse.alert_rules WHERE base_id=${base.id}::uuid AND lease_until>clock_timestamp() LIMIT 1`).length)
      return null;
    const [rule] = await tx<Claim[]>`SELECT *,
    (lease_id IS NOT NULL OR next_check_at + interval_seconds*interval '1 second'<=${now}) AS overdue
    FROM pulse.alert_rules WHERE base_id=${base.id}::uuid AND (next_check_at<=${now} OR lease_until<=clock_timestamp())
    ORDER BY next_check_at,id LIMIT 1 FOR UPDATE`;
    if (!rule) return null;
    const leaseId = crypto.randomUUID();
    await tx`UPDATE pulse.alert_rules SET lease_id=${leaseId}::uuid,lease_until=clock_timestamp()+interval '60 seconds',
    next_check_at=${now}::timestamptz+interval_seconds*interval '1 second' WHERE id=${rule.id}::uuid`;
    return { ...rule, lease_id: leaseId, reset_generation: base.reset_generation, claimed_at: now };
  });
/** Cancellation does not evaluate the rule. Restore its due time only while we
 * still own this revision/lease in the same active lifecycle generation. An
 * expired claim was already overdue before us; keep that fact on its next try. */
export const releaseCancelledAlert = async (claim: Claim, database = sql): Promise<void> => {
  await database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout='5s'`.simple();
    const [base] = await tx<{ deletion_started_at: Date | null }[]>`
      SELECT deletion_started_at FROM pulse.bases WHERE id=${claim.base_id}::uuid FOR UPDATE`;
    if (!base || base.deletion_started_at) return;
    const [store] = await tx<{ state: string; reset_generation: number }[]>`
      SELECT state,reset_generation FROM pulse.base_stores WHERE base_id=${claim.base_id}::uuid`;
    if (!store || store.state !== "active" || store.reset_generation !== claim.reset_generation) return;
    await tx`UPDATE pulse.alert_rules SET lease_id=NULL,lease_until=NULL,
      next_check_at=CASE WHEN ${claim.overdue}
        THEN LEAST(${claim.next_check_at}::timestamptz,${claim.claimed_at}::timestamptz-interval_seconds*interval '1 second')
        ELSE ${claim.next_check_at}::timestamptz END
      WHERE id=${claim.id}::uuid AND revision=${claim.revision} AND lease_id=${claim.lease_id}::uuid`;
  });
};

const statePriority = (state: AlertKeyState) =>
  state.state === "error"
    ? 6
    : state.state === "no_data"
      ? 5
      : state.state === "firing"
        ? state.severity === "critical"
          ? 4
          : 3
        : state.state === "pending"
          ? 2
          : 1;

/** The SQL result is complete before the transaction begins. Lease/revision
 * fencing prevents a timed-out or edited rule from committing an old result. */
export const applyAlertEvaluation = async (
  claim: Claim,
  result: Awaited<ReturnType<typeof runAlertSql>>,
  checkedAt: Date,
  locale: string,
  database = sql,
): Promise<boolean> =>
  database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout='10s'`.simple();
    const [base] = await tx<
      { short_id: string; name: string; deletion_started_at: Date | null }[]
    >`SELECT short_id,name,deletion_started_at FROM pulse.bases WHERE id=${claim.base_id}::uuid FOR UPDATE`;
    if (!base || base.deletion_started_at) return false;
    const [store] = await tx<{ state: string; reset_generation: number }[]>`
      SELECT state,reset_generation FROM pulse.base_stores WHERE base_id=${claim.base_id}::uuid`;
    if (!store || store.state !== "active" || store.reset_generation !== claim.reset_generation) return false;
    const [current] = await tx<
      { state: AlertStateName; severity: AlertSeverity | null; since: Date; incident_open: boolean; last_error: string | null }[]
    >`
    SELECT state,severity,since,incident_open,last_error FROM pulse.alert_rules WHERE id=${claim.id}::uuid
      AND revision=${claim.revision} AND lease_id=${claim.lease_id}::uuid AND lease_until>clock_timestamp() FOR UPDATE`;
    if (!current) return false;
    const rows = await tx<StateRow[]>`SELECT * FROM pulse.alert_states WHERE rule_id=${claim.id}::uuid ORDER BY key`;
    const previous = new Map(rows.map((row) => [row.key, fromRow(row)]));
    const parsed = result.ok ? readAlertValues(result.data) : null;
    let error = result.ok ? (parsed && !parsed.ok ? parsed.code : null) : result.error.code;
    const values = parsed?.ok ? parsed.values : new Map<string, number>();
    let keys = new Set([...previous.keys(), ...values.keys()]);
    if (keys.size > ALERT_MAX_KEYS) {
      error = "TOO_MANY_KEYS";
      keys = new Set(previous.keys());
    }
    const rule: AlertThresholds = {
      comparison: claim.comparison,
      warn: claim.warn,
      critical: claim.critical,
      minDurationSeconds: claim.min_duration_seconds,
      intervalSeconds: claim.interval_seconds,
    };
    const next = [...keys].map((key) =>
      nextAlertState(
        rule,
        key,
        previous.get(key) ??
          (previous.size === 0 && current.incident_open
            ? {
                key,
                state: current.state,
                severity: current.severity,
                value: null,
                since: iso(current.since),
                pendingSince: null,
                incidentOpen: true,
                lastCheckedAt: iso(current.since),
                lastError: current.last_error,
              }
            : undefined),
        { value: error ? null : (values.get(key) ?? null), ...(error ? { error } : {}) },
        checkedAt,
      ),
    );
    const changed = next.filter((item) => item.changed);
    // Replace the bounded snapshot under the rule lock. Text keys can exceed a
    // PostgreSQL btree entry, so they are never used as physical index keys.
    await tx`DELETE FROM pulse.alert_states WHERE rule_id=${claim.id}::uuid`;
    for (const { current: state } of next) {
      await tx`INSERT INTO pulse.alert_states(rule_id,key,state,severity,value,since,pending_since,incident_open,last_checked_at,last_error)
      VALUES(${claim.id}::uuid,${state.key},${state.state},${state.severity},${state.value},${state.since}::timestamptz,
        ${state.pendingSince}::timestamptz,${state.incidentOpen},${checkedAt},${state.lastError})`;
    }
    const worst = next.map((item) => item.current).sort((a, b) => statePriority(b) - statePriority(a))[0];
    const state = error ? "error" : (worst?.state ?? "no_data");
    const severity = error ? null : (worst?.severity ?? null);
    const summaryChanged = current.state !== state || current.severity !== severity;
    const incidentOpen = state === "pending" ? current.incident_open : state !== "ok";
    await tx`UPDATE pulse.alert_rules SET state=${state},severity=${severity},since=${summaryChanged ? checkedAt : current.since},
    incident_open=${incidentOpen},last_checked_at=${checkedAt},last_error=${error},lease_id=NULL,lease_until=NULL WHERE id=${claim.id}::uuid`;
    const common = { baseId: base.short_id, baseName: base.name, ruleId: claim.short_id, ruleName: claim.name };
    for (const item of next.filter((item) => item.notify)) {
      const s = item.current;
      await enqueueBaseNotice(
        tx,
        claim.base_id,
        { kind: "alert", data: { ...common, key: s.key, state: s.state, severity: s.severity, value: s.value, error: s.lastError } },
        locale,
      );
    }
    // Before any key has been seen, the rule itself carries missing/error state.
    // Its incident must still recover when the first valid result finally arrives.
    if (summaryChanged && next.length === 0) {
      await enqueueBaseNotice(
        tx,
        claim.base_id,
        { kind: "alert", data: { ...common, key: null, state, severity, value: null, error } },
        locale,
      );
    }
    if (summaryChanged || changed.length)
      await recordBaseActivity(tx, {
        baseId: claim.base_id,
        kind: "alert_transition",
        at: checkedAt,
        data: {
          ruleId: claim.short_id,
          name: claim.name,
          state,
          severity,
          keys: changed.map((item) => ({ key: item.current.key, state: item.current.state, severity: item.current.severity })),
        },
      });
    return true;
  });

/** Three workers match global SQL slots. Each tick starts at most 60 rules and
 * stops starting work after 50 s; each started rule owns a 10 s SQL deadline. */
export const evaluateDueAlerts = async (
  locale?: string,
  options: { signal?: AbortSignal; now?: () => Date; heartbeat?: () => Promise<void> } = {},
) => {
  const now = options.now ?? (() => new Date()),
    until = performance.now() + 50_000;
  let attempted = 0,
    applied = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: CLOUD_SLOTS }, async () => {
      for (let count = 0; count < 20 && performance.now() < until && !options.signal?.aborted; count++) {
        await options.heartbeat?.();
        if (options.signal?.aborted) break;
        // Resolve settings before taking a lease: a settings failure must not
        // strand a claim. Capture this locale with the resulting event.
        const language = await notificationLocale(locale);
        if (options.signal?.aborted) break;
        const claim = await claimDueAlert(now());
        if (!claim) break;
        attempted++;
        if (options.signal?.aborted) {
          await releaseCancelledAlert(claim);
          break;
        }
        let result: Awaited<ReturnType<typeof runAlertSql>>;
        try {
          result = claim.overdue
            ? { ok: false, error: { code: "OVERDUE", message: "The alert check is overdue", status: 503 } }
            : await runAlertSql({
                ruleId: claim.id,
                revision: claim.revision,
                leaseId: claim.lease_id,
                resetGeneration: claim.reset_generation,
                signal: options.signal,
              });
        } catch (error) {
          if (options.signal?.aborted) {
            await releaseCancelledAlert(claim);
            if (
              error === options.signal.reason ||
              (error instanceof Error && (error.name === "AbortError" || ("code" in error && error.code === "CANCELLED")))
            )
              break;
          }
          // A coincident shutdown must not hide a real transport/programming failure.
          throw error;
        }
        if (options.signal?.aborted) {
          await releaseCancelledAlert(claim);
          break;
        }
        if (await applyAlertEvaluation(claim, result, now(), language)) applied++;
        await options.heartbeat?.();
      }
    }),
  );
  const failed = workers.filter((worker) => worker.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((worker) => worker.reason),
      "Pulse alert evaluation failed",
    );
  return { attempted, applied };
};
