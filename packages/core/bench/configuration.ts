import assert from "node:assert/strict";

export const benchmarkConfiguration = (env: Record<string, string | undefined>) => {
  const mode = env.IDENTITY_BENCH_MODE ?? "measure";
  assert(mode === "measure" || mode === "profile" || mode === "direct-postgres", "Unknown identity benchmark mode");
  const samples = Number(env.IDENTITY_BENCH_SAMPLES ?? 200);
  assert(Number.isSafeInteger(samples) && samples >= 20 && samples <= 2_000, "Expected 20..2000 samples per mode");
  return { mode, samples, acceptanceEligible: mode === "measure" && samples >= 200 };
};
