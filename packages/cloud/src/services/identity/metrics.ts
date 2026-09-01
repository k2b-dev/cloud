export type IdentityMetricName =
  | "sign_success"
  | "sign_failure"
  | "verify_success"
  | "verify_failure"
  | "unknown_kid_refresh"
  | "rotation_success"
  | "rotation_failure"
  | "legacy_session_use";

const names: IdentityMetricName[] = [
  "sign_success",
  "sign_failure",
  "verify_success",
  "verify_failure",
  "unknown_kid_refresh",
  "rotation_success",
  "rotation_failure",
  "legacy_session_use",
];

const counters = new Map<IdentityMetricName, number>(names.map((name) => [name, 0]));

export const identityMetrics = {
  increment(name: IdentityMetricName): void {
    counters.set(name, (counters.get(name) ?? 0) + 1);
  },
  snapshot(): Readonly<Record<IdentityMetricName, number>> {
    return Object.freeze(Object.fromEntries(names.map((name) => [name, counters.get(name) ?? 0])) as Record<IdentityMetricName, number>);
  },
};
