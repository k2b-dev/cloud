import { expect, test } from "bun:test";
import { join } from "node:path";
import { exampleResult } from "./example-result";
import { help, parseArgs, parsePrevious, renderSummary, resultSchema, statistics, summarizeSamples } from "./model";

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

test("JSON keeps all statement IDs while the summary displays only the top 20", () => {
  const result = exampleResult();
  result.scenarios[0]!.database = {
    windowMs: 100,
    calls: 25,
    callsPerRun: 25,
    totalMs: 25,
    msPerRun: 25,
    statements: Array.from({ length: 25 }, (_, i) => ({
      query: `SELECT column_${i} FROM mail.conversations`,
      queryid: String(9007199254740993n + BigInt(i)),
      calls: 1,
      totalMs: 1,
      meanMs: 1,
      rows: 1,
      hits: 0,
      reads: 0,
    })),
  };
  const parsed = resultSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(parsed.scenarios[0]!.database!.statements).toHaveLength(25);
  expect(parsed.scenarios[0]!.database!.statements[24]!.queryid).toBe("9007199254741017");
  const summary = renderSummary(parsed);
  expect(summary).toContain("SELECT column_19 FROM");
  expect(summary).not.toContain("SELECT column_20 FROM");
  // Comparison with pre-queryid results remains supported.
  const oldStatements = result.scenarios[0]!.database!.statements.map(({ queryid, ...statement }) => statement);
  result.scenarios[0]!.database!.statements = oldStatements;
  expect(parsePrevious(result).scenarios[0]!.database!.statements).toHaveLength(25);
});

test("summary retains metrics and reports optional plan capture errors and skipped entries", () => {
  const result = exampleResult();
  const scenario = result.scenarios[0]!;
  scenario.planError = "auto_explain pass produced no request plan";
  scenario.unparsedPlans = 1;
  const summary = renderSummary(result);
  expect(summary).toContain("10.0 / 30.0 / 40.0");
  expect(summary).toContain("Plan error: auto_explain pass produced no request plan");
  expect(summary).toContain("Unparsed plan log entries: 1");
  expect(summary).not.toContain("**FAILED**");
  // Earlier schemaVersion 1 results remain valid comparison inputs.
  const { planError, unparsedPlans, ...oldScenario } = scenario;
  const parsed = parsePrevious({ ...result, scenarios: [oldScenario] });
  expect(parsed.scenarios[0]).toMatchObject({ planError: null, unparsedPlans: 0 });
});

test("mailbox B metadata is optional for comparison and reports its own seed duration", () => {
  const old = exampleResult();
  expect(parsePrevious(old).metadata.mailboxB).toBeUndefined();
  const result = resultSchema.parse({
    ...old,
    metadata: {
      ...old.metadata,
      mailboxB: {
        fixture: { ...old.metadata.fixture, seed: old.metadata.fixture.seed + 1 },
        fixtureDigest: "mailbox-b-digest",
        seedDurationMs: 123,
      },
    },
  });
  expect(renderSummary(result, old)).toContain("digest mailbox-b-digest; seed duration 123.0 ms");
  expect(result.metadata.seedDurationMs).toBe(old.metadata.seedDurationMs);
});
