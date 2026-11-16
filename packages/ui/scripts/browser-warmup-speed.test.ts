import { expect, test } from "bun:test";
import { slowRunnerError } from "../test/browser";

// Warm scenes of WebKit warm-ups in runs 43836439570 and 43840817498: shards of normal runners, then shard 17, where
// bun install already took 20 s instead of 3–8 s and 14 recovery tests ran into their 5 s one after another (#3526).
const normalRunners = [
  [768, 845, 781],
  [1345, 1614, 1175],
  [1387, 1583, 1164],
];
const slowRunner = [5402, 4387, 4396];

test("a normal runner's warm-up lets the browser suites run", () => {
  for (const scenes of normalRunners) expect(slowRunnerError(scenes)).toBeUndefined();
});

test("a runner that needs half a test's 5 s for each warm scene stops before the first suite", () => {
  expect(slowRunnerError(slowRunner)).toContain("at least 4387 ms");
  // One slow scene on a normal runner is a hiccup; only the fastest scene speaks for the runner.
  expect(slowRunnerError([900, 4800, 1000])).toBeUndefined();
});
