import { expect, test } from "bun:test";
import { benchmarkConfiguration } from "./configuration";

test("only full unprofiled metered measurements are eligible for acceptance", () => {
  expect(benchmarkConfiguration({})).toEqual({ mode: "measure", samples: 200, topology: "split", acceptanceEligible: true });
  expect(benchmarkConfiguration({ IDENTITY_BENCH_TOPOLOGY: "shared" }).topology).toBe("shared");
  for (const mode of ["profile", "direct-postgres"]) {
    expect(benchmarkConfiguration({ IDENTITY_BENCH_MODE: mode }).acceptanceEligible).toBeFalse();
  }
  expect(benchmarkConfiguration({ IDENTITY_BENCH_SAMPLES: "20" }).acceptanceEligible).toBeFalse();
});

test("invalid benchmark configuration fails before infrastructure is started", () => {
  expect(() => benchmarkConfiguration({ IDENTITY_BENCH_MODE: "typo" })).toThrow();
  expect(() => benchmarkConfiguration({ IDENTITY_BENCH_TOPOLOGY: "typo" })).toThrow();
  for (const samples of ["", "NaN", "19", "2001", "20.5"]) {
    expect(() => benchmarkConfiguration({ IDENTITY_BENCH_SAMPLES: samples })).toThrow();
  }
});
