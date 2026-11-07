import { expect, test } from "bun:test";
import { collectJobTimes, jobMode, parseSuiteTimes, recommendShardCount, refreshSuiteWeights } from "./test-weights";

test("parses bare and timestamped suite times, ignoring headers and keeping the maximum", () => {
  const log = [
    "=== @k2b/ui ===",
    "=== integration database bootstrap ===",
    "2026-10-19T14:43:16.9438507Z === @k2b/ui ===",
    "2026-10-19T14:43:16.9438507Z === @k2b/ui src/x.browser.test.ts: 5.6s",
    "=== @k2b/ui: 12.3s",
    "=== @k2b/ui: 9.9s",
    "2026-10-19T14:43:16Z === @k2b/ui: 13.1s",
    "=== @k2b/app src/[id]/test: special.browser.test.ts: 2.4s",
    "=== zero: 0s",
    "unrelated output: 8.3s",
    "=== unfinished: 4.2s trailing output",
  ].join("\r\n");
  expect(parseSuiteTimes(log)).toEqual(
    new Map([
      ["@k2b/ui src/x.browser.test.ts", 5.6],
      ["@k2b/ui", 13.1],
      ["@k2b/app src/[id]/test: special.browser.test.ts", 2.4],
      ["zero", 0],
    ]),
  );
});

test("refreshes integration weights from both historical and sharded CI jobs", () => {
  expect(jobMode("integration")).toBe("integration");
  expect(jobMode("integration (3)")).toBe("integration");
  expect(jobMode("unit (2)")).toBe("unit");
  expect(jobMode("webkit (7)")).toBe("browser");
  expect(jobMode("grids (1)")).toBeUndefined();
  expect(jobMode("integration extra")).toBeUndefined();
});

test("imports completed suites from failed and budget-aborted jobs instead of selecting only green measurements", () => {
  const jobs = [
    { id: 1, name: "webkit (1)", conclusion: "success" },
    { id: 2, name: "webkit (4)", conclusion: "failure" },
    { id: 3, name: "integration (2)", conclusion: "timed_out" },
    { id: 4, name: "unit (1)", conclusion: "cancelled" },
    { id: 5, name: "grids (1)", conclusion: "success" },
    { id: 6, name: "webkit (5)", conclusion: "skipped" },
  ];
  const logs: Record<number, string> = {
    1: "=== live-turn: 72.7s",
    2: [
      "=== live-turn: 244.5s",
      "=== service-accounts: 101.4s",
      "=== full-width ===",
      "::error::Time budget exhausted during full-width",
    ].join("\n"),
    3: "=== database: 23s",
    4: "=== package: 45s",
  };
  const read = (id: number) => {
    if (!(id in logs)) throw new Error(`unexpected log request: ${id}`);
    return logs[id]!;
  };
  const times = collectJobTimes(jobs, read);
  expect(times.browser).toEqual(
    new Map([
      ["live-turn", 244.5],
      ["service-accounts", 101.4],
    ]),
  );
  expect(times.integration).toEqual(new Map([["database", 23]]));
  expect(times.unit).toEqual(new Map([["package", 45]]));
  expect(collectJobTimes(jobs, read, ["browser"]).unit.size).toBe(0);
  expect(() => collectJobTimes([{ ...jobs[0], conclusion: null }], read)).toThrow("expected success, failure, timed_out, or cancelled");
});

test("retains the unexecuted tail after a failed job, prunes deleted suites, and replaces old measurements on refresh", () => {
  const suites = ["live-turn", "full-width", "new-file"].map((name) => ({ name, cwd: "", command: [] }));
  const before = { "live-turn": 72.7, "full-width": 40, deleted: 500 };
  const slow = refreshSuiteWeights(
    suites,
    before,
    new Map([
      ["live-turn", 244.5],
      ["new-file", 6.4],
    ]),
  );
  expect(slow).toEqual({ "full-width": 40, "live-turn": 244.5, "new-file": 6.4 });
  expect(refreshSuiteWeights(suites, slow, new Map([["live-turn", 65]]))).toEqual({ ...slow, "live-turn": 65 });
});

test("recommends matrices beyond eight shards and refuses an indivisible oversized suite", () => {
  const suites = Array.from({ length: 18 }, (_, index) => ({ name: `file-${index}`, cwd: "", command: [] }));
  const weights = Object.fromEntries(suites.map((suite) => [suite.name, 450]));
  expect(recommendShardCount(suites, weights)).toBe(9);
  expect(recommendShardCount(suites, { ...weights, "file-0": 901 })).toBeUndefined();
  expect(recommendShardCount([], {})).toBeUndefined();
});
