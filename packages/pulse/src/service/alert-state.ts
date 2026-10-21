import { ALERT_MAX_KEYS, type AlertKeyState, type AlertSeverity, type AlertThresholds } from "../alert-contracts";
import type { SqlRows } from "../store/sql-run";

export type AlertResultError = "INVALID_COLUMNS" | "INVALID_KEY" | "DUPLICATE_KEY" | "INVALID_VALUE" | "TOO_MANY_KEYS";
type AlertValues = { ok: true; values: Map<string, number> } | { ok: false; code: AlertResultError };
const numericType = /^(?:U?Int\d+|Float\d+|Decimal(?:\d+)?(?:\([^)]*\))?)$/;

/** Validate the complete result before changing any key's state. */
export const readAlertValues = (result: Pick<SqlRows, "columns" | "rows" | "truncated">): AlertValues => {
  if (result.truncated || result.rows.length > ALERT_MAX_KEYS) return { ok: false, code: "TOO_MANY_KEYS" };
  const keys = result.columns.flatMap((column, index) => (column.name === "key" ? [index] : []));
  const values = result.columns.flatMap((column, index) => (column.name === "value" ? [index] : []));
  if (keys.length !== 1 || values.length !== 1) return { ok: false, code: "INVALID_COLUMNS" };
  const keyIndex = keys[0]!,
    valueIndex = values[0]!;
  const type = result.columns[valueIndex]!.type.replace(/^Nullable\((.*)\)$/, "$1");
  if (!numericType.test(type)) return { ok: false, code: "INVALID_COLUMNS" };
  const parsed = new Map<string, number>();
  for (const row of result.rows) {
    const key = row[keyIndex],
      raw = row[valueIndex];
    if (typeof key !== "string" || !key.length || key.includes("\0") || !key.isWellFormed()) return { ok: false, code: "INVALID_KEY" };
    if (parsed.has(key)) return { ok: false, code: "DUPLICATE_KEY" };
    // ClickHouse encodes wide integers and decimals as strings. Accept numeric
    // strings only under numeric metadata, never null/booleans/empty strings.
    const value =
      typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || (/^U?Int/.test(type) && !Number.isSafeInteger(value))) return { ok: false, code: "INVALID_VALUE" };
    parsed.set(key, value);
  }
  return { ok: true, values: parsed };
};

const severityFor = (rule: AlertThresholds, value: number): AlertSeverity | null => {
  const exceeds = (threshold: number | null) => threshold !== null && (rule.comparison === "above" ? value > threshold : value < threshold);
  return exceeds(rule.critical) ? "critical" : exceeds(rule.warn) ? "warn" : null;
};

/** A missing value or failed evaluation interrupts the continuous breach. */
export const nextAlertState = (
  rule: AlertThresholds,
  key: string,
  previous: AlertKeyState | undefined,
  observation: { value: number | null; error?: string },
  checkedAt: Date,
): { current: AlertKeyState; changed: boolean; notify: boolean } => {
  const at = checkedAt.toISOString();
  const error = observation.error ?? (observation.value !== null && !Number.isFinite(observation.value) ? "INVALID_VALUE" : undefined);
  const severity = error || observation.value === null ? null : severityFor(rule, observation.value);
  const pendingSince = severity ? (previous?.pendingSince ?? at) : null;
  const state = error
    ? "error"
    : observation.value === null
      ? "no_data"
      : severity
        ? checkedAt.getTime() - Date.parse(pendingSince!) >= rule.minDurationSeconds * 1000
          ? "firing"
          : "pending"
        : "ok";
  const changed = previous?.state !== state || previous.severity !== severity;
  return {
    current: {
      key,
      state,
      severity,
      value: error ? null : observation.value,
      since: !changed && previous ? previous.since : at,
      pendingSince,
      incidentOpen: state === "pending" ? (previous?.incidentOpen ?? false) : state !== "ok",
      lastCheckedAt: at,
      lastError: error ?? null,
    },
    changed,
    notify:
      changed &&
      state !== "pending" &&
      !(state === "firing" && previous?.state === "firing" && severity !== "critical") &&
      !(state === "ok" && !previous?.incidentOpen),
  };
};
