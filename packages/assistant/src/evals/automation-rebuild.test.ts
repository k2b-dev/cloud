import { expect, test } from "bun:test";
import { z } from "zod";
import { AUTOMATION_REBUILD_CASES, type AutomationRebuildTrace, scoreAutomationRebuild } from "./automation-rebuild";

const passing = (): AutomationRebuildTrace => {
  const config = { codeId: "fixture-code", baseVersionId: null };
  const source = { codeId: config.codeId, entry: "code.ts", files: { "code.ts": "// fictional candidate" } };
  const tests = {
    "test/report.json": JSON.stringify({
      version: 1,
      name: "report",
      now: 1894006800000,
      seed: 42,
      mocks: [],
      runs: [{ entrypoint: "report", expect: { ok: true, calls: [] } }],
    }),
  };
  return {
    answer: "Submitted for human review; remains inactive.",
    calls: [
      { name: "code_init", args: { title: "Fixture" }, result: { config } },
      { name: "code_sdk", args: { codeId: config.codeId }, result: { files: {} } },
      { name: "code_write", args: { path: "code.ts", content: source.files["code.ts"] }, result: { config, files: source.files } },
      { name: "code_check", args: source, result: { result: { ok: true } } },
      { name: "code_test", args: { ...source, tests }, result: { ok: true } },
      { name: "code_submit", args: { ...source, tests, baseVersionId: null }, result: { submission: { id: "fixture-version" } } },
    ],
  };
};

test("ships both full v1 export fixtures without importing the old automation services", () => {
  expect(AUTOMATION_REBUILD_CASES.map((item) => item.export.format)).toEqual(["cloud.mail-automation", "cloud.chat-tasks"]);
  for (const item of AUTOMATION_REBUILD_CASES) {
    expect(item.export).toMatchObject({ version: 1, authority: "none", nextCursor: null });
    expect(item.export.items).toHaveLength(1);
  }
});

test("scores same-source authoring evidence, with semantic review still required", () => {
  expect(scoreAutomationRebuild(passing())).toEqual({ mechanicalPassed: true, failures: [], semanticReviewRequired: true });
});

test("accepts pulling an agreed replacement and the real read/discovery/simulation tools", () => {
  const trace = passing();
  trace.calls[0]!.name = "code_pull";
  trace.calls[0]!.args = { codeId: "fixture-code" };
  trace.calls.push(
    ...["search_skills", "list_apps", "search_help", "read_help", "code_simulate"].map((name) => ({ name, args: {}, result: {} })),
  );
  expect(scoreAutomationRebuild(trace).mechanicalPassed).toBe(true);
});

test("rejects empty assertions even when fixed fixtures were passed to test and submit", () => {
  const trace = passing();
  for (const call of [trace.calls[4]!, trace.calls[5]!]) {
    const args = z.record(z.string(), z.json()).parse(call.args);
    const tests = z.record(z.string(), z.string()).parse(args.tests);
    const fixture = JSON.parse(tests["test/report.json"]!);
    fixture.runs[0].expect = {};
    call.args = { ...args, tests: { "test/report.json": JSON.stringify(fixture) } };
  }
  expect(scoreAutomationRebuild(trace).mechanicalPassed).toBe(false);
});

test("rejects changed source, tests or base after successful checks", () => {
  for (const change of [{ files: { "code.ts": "changed after test" } }, { tests: {} }, { baseVersionId: "changed-base" }]) {
    const trace = passing();
    const last = trace.calls.at(-1)!;
    last.args = z.json().parse({ ...z.record(z.string(), z.json()).parse(last.args), ...change });
    expect(scoreAutomationRebuild(trace).mechanicalPassed).toBe(false);
  }
});

test("rejects runner failures, skipped authoring steps, activation and missing fixed fixtures", () => {
  const failed = passing();
  failed.calls[4]!.result = { ok: false, error: "runner_failed" };
  const skipped = passing();
  skipped.calls.splice(2, 1);
  const activated = passing();
  activated.calls.push({ name: "code_activate", args: {}, result: { ok: true } });
  const unfixed = passing();
  for (const call of [unfixed.calls[4]!, unfixed.calls[5]!])
    call.args = { ...z.record(z.string(), z.json()).parse(call.args), tests: { "test/a.json": JSON.stringify({ version: 1, runs: [] }) } };
  for (const trace of [failed, skipped, activated, unfixed]) expect(scoreAutomationRebuild(trace).mechanicalPassed).toBe(false);
});
