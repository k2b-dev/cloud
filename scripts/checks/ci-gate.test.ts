import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { workspaceRoot } from "../workspace";
import { gateStep, rule, workflowSchema } from "./ci-gate";

// The gate step runs jq, as it does on the runner; name the missing tool instead of failing every case.
if (!Bun.which("jq")) throw new Error("scripts/checks/ci-gate.test.ts needs jq on PATH to run the gate step from ci.yml");

const sourceText = await readFile(join(workspaceRoot, ".github", "workflows", "ci.yml"), "utf8");
const source = Bun.YAML.parse(sourceText);
const workflow = workflowSchema.parse(source);
const step = gateStep(workflow);
const jobs = workflow.jobs.gate?.needs ?? [];
const pathFiltered = step?.env?.MAY_SKIP?.split(" ") ?? [];
const draftFiltered = step?.env?.DRAFT_MAY_SKIP?.split(" ") ?? [];

/** Runs the gate step of ci.yml with this RESULTS value, like the runner does. */
const runGate = async (results: string, isDraft = false) => {
  const child = Bun.spawn(["bash", "-c", step?.run ?? "exit 2"], {
    env: { PATH: process.env.PATH, ...step?.env, RESULTS: results, IS_DRAFT: String(isDraft) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim() };
};

/** Runs the gate step with these job results; every unnamed job succeeded. */
const gate = (results: Record<string, string | undefined>, isDraft = false) =>
  runGate(JSON.stringify(Object.fromEntries(jobs.map((id) => [id, { result: results[id] ?? "success", outputs: {} }]))), isDraft);

// These workflow expressions use the same comparisons and boolean operators as JavaScript.
const evaluateCondition = (expression: string, eventName: string, draft?: boolean, changed = true): boolean =>
  new Function("github", "needs", `return (${expression})`)(
    { event_name: eventName, event: { pull_request: draft === undefined ? undefined : { draft } } },
    {
      changes: {
        outputs: Object.fromEntries(
          [...pathFiltered, "cloud", "release", "releasebody", "runner"].map((id) => [
            id,
            changed ? "true" : id === "bundles" ? "" : "false",
          ]),
        ),
      },
    },
  ) === true;

test("ready_for_review runs CI and PR concurrency never cancels merge groups", () => {
  const trigger = z
    .object({
      on: z.object({ pull_request: z.object({ types: z.array(z.string()) }), merge_group: z.null(), workflow_dispatch: z.null() }),
      concurrency: z.object({ group: z.string(), "cancel-in-progress": z.string() }),
    })
    .parse(source);
  expect(trigger.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  expect(trigger.concurrency).toEqual({
    group: "ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});

test("draft events run only the light jobs; ready PRs, merge groups, and dispatch retain full CI", async () => {
  for (const [eventName, draft] of [
    ["pull_request", true],
    ["pull_request", false],
    ["merge_group", undefined],
    ["merge_group", true],
    ["workflow_dispatch", undefined],
  ] as const) {
    const isDraft = evaluateCondition(step?.env?.IS_DRAFT?.slice(3, -2) ?? "false", eventName, draft);
    expect(isDraft).toBe(eventName === "pull_request" && draft === true);
    for (const changed of [true, false]) {
      const selected = Object.entries(workflow.jobs)
        .filter(
          ([id, job]) =>
            id === "gate" || job.if === undefined || (typeof job.if === "string" && evaluateCondition(job.if, eventName, draft, changed)),
        )
        .map(([id]) => id);
      expect(selected).toEqual(
        isDraft
          ? ["changes", "setup", "check", "gate"]
          : changed
            ? [...jobs, "gate"]
            : ["changes", "mirror", "setup", "check", "unit", "integration", "gate"],
      );
      expect(await gate(Object.fromEntries(jobs.filter((id) => !selected.includes(id)).map((id) => [id, "skipped"])), isDraft)).toEqual({
        code: 0,
        stderr: "",
      });
    }
  }
});

test("draft skips cannot pass the full gate and draft failures are still visible", async () => {
  const skipped = Object.fromEntries([...pathFiltered, ...draftFiltered].map((id) => [id, "skipped"]));
  expect(await gate(skipped, true)).toEqual({ code: 0, stderr: "" });
  expect(await gate(skipped)).toEqual({
    code: 1,
    stderr: "Jobs that did not pass: mirror (skipped), unit (skipped), integration (skipped)",
  });
  for (const id of ["changes", "setup", "check"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(await gate({ ...skipped, [id]: result }, true)).toEqual({ code: 1, stderr: `Jobs that did not pass: ${id} (${result})` });
    }
  }
  for (const id of [...pathFiltered, ...draftFiltered]) {
    expect(await gate({ ...skipped, [id]: "failure" }, true)).toEqual({ code: 1, stderr: `Jobs that did not pass: ${id} (failure)` });
  }
});

test("the gate passes when every job succeeded or a path-filtered job was skipped", async () => {
  expect(await gate({})).toEqual({ code: 0, stderr: "" });
  expect(await gate(Object.fromEntries(pathFiltered.map((id) => [id, "skipped"])))).toEqual({ code: 0, stderr: "" });
});

test("the gate fails on every other result and names the jobs", async () => {
  for (const result of ["failure", "cancelled", "abandoned", "timed_out", "neutral", ""]) {
    expect(await gate({ integration: result })).toEqual({ code: 1, stderr: `Jobs that did not pass: integration (${result})` });
  }
});

test("the UI build job does not repeat the unit shards' tests", () => {
  const commands = workflow.jobs.ui?.steps.map((step) => step.run ?? "");
  expect(commands).toBeDefined();
  expect(commands?.some((command) => /\bbun (?:run .*\btest\b|test\b)/.test(command))).toBeFalse();
});

test("the gate fails when a job that must always run was skipped", async () => {
  // setup failed, so check, unit, and integration were skipped behind it.
  expect(await gate({ setup: "failure", check: "skipped", unit: "skipped", integration: "skipped" })).toEqual({
    code: 1,
    stderr: "Jobs that did not pass: setup (failure), check (skipped), unit (skipped), integration (skipped)",
  });
  // An abandoned `changes` skips every path-filtered job; only `changes` reveals it.
  expect(await gate({ changes: "abandoned", ...Object.fromEntries(pathFiltered.map((id) => [id, "skipped"])) })).toEqual({
    code: 1,
    stderr: "Jobs that did not pass: changes (abandoned)",
  });
  expect(await gate({ changes: "skipped" })).toEqual({ code: 1, stderr: "Jobs that did not pass: changes (skipped)" });
});

test("the gate fails when it got no job results", async () => {
  for (const results of ["", "{}", "[]", "null"]) {
    expect(await runGate(results)).toEqual({ code: 1, stderr: "The gate got no job results" });
  }
});

test("a .github file that a ci.yml step runs is a shared input, so changing it runs the jobs that use it", () => {
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
  const shared = runs.map((run) => /^\s*shared='([^']+)'$/m.exec(run)?.[1]).find(Boolean);
  if (!shared) throw new Error("the changes job no longer sets shared='<pattern>'");
  const files = new Set(runs.flatMap((run) => [...run.matchAll(/\.github\/[\w./-]+/g)].map(([path]) => path)));
  expect(files.size).toBeGreaterThan(0);
  expect([...files].filter((file) => !new RegExp(shared).test(file))).toEqual([]);
});

test("ci.yml passes the rule", async () => {
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
});

test("the rule rejects widening skip allowances or dropping draft guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ci-drafts-"));
  try {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    for (const [before, after, message] of [
      ["MAY_SKIP: webkit", "MAY_SKIP: unit webkit", "MAY_SKIP lists unit, which it must not"],
      [
        "DRAFT_MAY_SKIP: mirror unit integration",
        "DRAFT_MAY_SKIP: mirror unit integration setup",
        "DRAFT_MAY_SKIP lists setup, which it must not",
      ],
      [
        "  mirror:\n    if: github.event_name != 'pull_request' || github.event.pull_request.draft != true",
        "  mirror:",
        "mirror must exclude draft PRs with the full-CI condition",
      ],
      [
        "IS_DRAFT: ${{ github.event_name == 'pull_request' && github.event.pull_request.draft == true }}",
        "IS_DRAFT: ${{ github.event.pull_request.draft == true }}",
        "the gate step must restrict IS_DRAFT to an actual draft pull_request event",
      ],
    ]) {
      expect(sourceText).toContain(before);
      await writeFile(join(root, ".github", "workflows", "ci.yml"), sourceText.replace(before, after));
      const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
      expect(findings.map((finding) => finding.message)).toContain(message);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a gate that misses a job, allows a skip that is not a path filter, or hides a cascading skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ci-gate-"));
  try {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  changes: {}",
        "  check: { needs: changes, if: false }",
        "  lint: { needs: changes, if: \"github.event_name != 'merge_group'\" }",
        "  docs: { needs: changes, if: \"needs.changes.outputs.docs == 'true'\" }",
        "  ui: { needs: changes, if: \"needs.changes.outputs.ui == 'true'\" }",
        "  site: { needs: [changes, ui], if: \"needs.changes.outputs.site == 'true'\" }",
        "  gate:",
        "    needs: [changes, check, lint, docs, site]",
        "    steps:",
        "      - env: { RESULTS: '${{ toJSON(needs.docs) }}', MAY_SKIP: docs ui site check lint setup }",
      ].join("\n"),
    );
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => finding.message)).toEqual([
      "jobs.gate must run with `if: always()`",
      "the gate step must set RESULTS to `${{ toJSON(needs) }}`",
      "the gate step must restrict IS_DRAFT to an actual draft pull_request event",
      "jobs.gate.needs is missing ui",
      "check may be skipped only by a path filter: its `if:` must read needs.changes.outputs and it must need changes",
      "lint may be skipped only by a path filter: its `if:` must read needs.changes.outputs and it must need changes",
      "lint must exclude draft PRs with the full-CI condition",
      "docs must exclude draft PRs with the full-CI condition",
      "ui must exclude draft PRs with the full-CI condition",
      "site must exclude draft PRs with the full-CI condition",
      "check must run for draft PRs too, without a job condition",
      "MAY_SKIP lists check, which it must not",
      "MAY_SKIP lists lint, which it must not",
      "MAY_SKIP lists setup, which it must not",
      "site needs ui, which may be skipped; a cascading skip would hide in the gate",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
