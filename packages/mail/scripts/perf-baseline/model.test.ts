import { expect, test } from "bun:test";
import { join } from "node:path";
import { help, parseArgs, parsePrevious, type Result, renderSummary, resultSchema, statistics, summarizeSamples } from "./model";

export function exampleResult(): Result {
  return {
    schemaVersion: 1,
    kind: "mail",
    metadata: {
      commit: "abc",
      dirty: true,
      timestamp: "2026-10-01T00:00:00Z",
      bunVersion: "1",
      runtimeImage: "bun",
      cpuCount: 8,
      cpuModel: "Test CPU",
      loadAverage: { start: [1, 2, 3], end: [2, 3, 4] },
      runs: 2,
      fixture: { seed: 1, anchor: "2026-10-01T00:00:00Z", messages: 600, conversations: 120, folders: 6 },
      fixtureDigest: "digest",
      shape: {},
      seedDurationMs: 1,
      bm25: false,
      pgTextsearch: false,
      postgresVersion: "17",
      origin: "https://localhost:4000",
    },
    idle: null,
    notes: ["No provider connection"],
    errors: [],
    scenarios: [
      {
        id: "detail-small",
        group: "Details",
        status: "ok",
        errors: [],
        notes: [],
        database: null,
        plan: null,
        metrics: null,
        samples: [10, 20, 40].map((totalMs) => ({
          totalMs,
          ttfbMs: totalMs / 2,
          rawBytes: 100,
          brotliBytes: 30,
          propsBytes: 10,
          requests: [],
        })),
      },
    ],
  };
}
test("arguments: defaults, limits, invalid and unknown flags", () => {
  expect(parseArgs([])).toMatchObject({ messages: 20000, conversations: 3000, folders: 30, runs: 5, seed: 20261001 });
  expect(
    parseArgs([
      "--messages",
      "100000",
      "--conversations",
      "100000",
      "--folders",
      "1000",
      "--runs",
      "50",
      "--seed",
      "0",
      "--out",
      "a",
      "--compare",
      "b",
      "--keep",
      "--skip-build",
    ]),
  ).toMatchObject({ messages: 100000, folders: 1000, runs: 50, keep: true, skipBuild: true, out: "a", compare: "b" });
  for (const args of [
    ["--messages", "0"],
    ["--messages", "100001"],
    ["--messages", "1"],
    ["--conversations", "20001"],
    ["--conversations", "0"],
    ["--folders", "5"],
    ["--folders", "1001"],
    ["--runs", "0"],
    ["--runs", "51"],
    ["--runs", "1.1"],
    ["--seed", "-1"],
    ["--seed", "4294967296"],
    ["--runs"],
    ["--unknown"],
    ["foo"],
  ])
    expect(() => parseArgs(args)).toThrow();
  expect(help).toContain("--folders 350");
});
test("--help exits quickly without Docker, builds, or flock available", async () => {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../perf-baseline.ts"), "--help"], {
    env: { PATH: "/nonexistent", CLOUD_HEAVY_LOCK: "not-held" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("Usage:");
  expect(stdout).toContain("heavy lock");
  expect(performance.now() - started).toBeLessThan(5000);
});
test("summary is pure, shows failed scenarios and median comparisons", () => {
  const r = exampleResult(),
    before = structuredClone(r);
  expect(resultSchema.parse(r).kind).toBe("mail");
  expect(renderSummary(r)).toContain("10.0 / 30.0 / 40.0");
  expect(renderSummary(r)).not.toContain("## Median deltas");
  r.scenarios[0]!.samples[1]!.totalMs = 40;
  expect(renderSummary(r, before)).toContain("| detail-small | totalMs | 10.0 |");
  r.scenarios[0]!.status = "failed";
  r.scenarios[0]!.errors.push("Broken response");
  expect(renderSummary(r, before)).toContain("**FAILED**");
  expect(renderSummary(r)).toContain("Broken response");
  expect(renderSummary(r, before)).toContain("| detail-small | totalMs | — |");
  const frozen = JSON.stringify(r);
  renderSummary(r, before);
  expect(JSON.stringify(r)).toBe(frozen);
  expect(summarizeSamples(before.scenarios[0]!.samples).totalMs).toEqual({ cold: 10, median: 30, p95: 40 });
  expect(statistics([1, 2, 3, 4])).toEqual({ median: 2.5, p95: 4 });
});
test("compare schema clearly rejects page results, wrong versions and corrupt mail results", () => {
  expect(() => parsePrevious({ schemaVersion: 1, pages: [] })).toThrow("Mail result");
  expect(() => parsePrevious({ ...exampleResult(), schemaVersion: 2 })).toThrow();
  expect(() => parsePrevious({ kind: "mail", schemaVersion: 1 })).toThrow();
  expect(parsePrevious(exampleResult()).kind).toBe("mail");
});

test("summary labels explain matches and warns when falling back to a possible background plan", () => {
  const result = exampleResult();
  const scenario = result.scenarios[0]!;
  scenario.plan = { query: "SELECT $1", matched: false, durationMs: 12, node: "Result", totalMs: 12, hits: 0, reads: 0, plan: {} };
  expect(renderSummary(result)).toContain("unmatched (may be background)");
  scenario.plan.matched = true;
  expect(renderSummary(result)).toContain("Slowest explain (matched)");
  expect(renderSummary(result)).not.toContain("may be background");
});
