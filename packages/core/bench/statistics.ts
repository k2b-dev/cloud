import assert from "node:assert/strict";

export const summary = (values: number[]) => {
  assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0), "Expected finite duration samples");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samples: values.length,
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
};

export const compare = (legacy: number[], jwt: number[]) => {
  assert.equal(legacy.length, jwt.length, "Compare equal sample counts");
  const before = summary(legacy);
  const after = summary(jwt);
  const allowedRegressionMs = Math.max(10, before.p95Ms * 0.1);
  const regressionMs = after.p95Ms - before.p95Ms;
  return { legacy: before, jwt: after, allowedRegressionMs, regressionMs, passes: regressionMs <= allowedRegressionMs };
};
