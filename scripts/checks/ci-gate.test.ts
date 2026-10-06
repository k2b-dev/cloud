import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../workspace";
import { gateStep, rule, workflowSchema } from "./ci-gate";

// The gate step runs jq, as it does on the runner; name the missing tool instead of failing every case.
if (!Bun.which("jq")) throw new Error("scripts/checks/ci-gate.test.ts needs jq on PATH to run the gate step from ci.yml");

const workflow = workflowSchema.parse(Bun.YAML.parse(await readFile(join(workspaceRoot, ".github", "workflows", "ci.yml"), "utf8")));
const step = gateStep(workflow);
const jobs = workflow.jobs.gate?.needs ?? [];
const pathFiltered = step?.env?.MAY_SKIP?.split(" ") ?? [];

/** Runs the gate step of ci.yml with this RESULTS value, like the runner does. */
const runGate = async (results: string) => {
  const child = Bun.spawn(["bash", "-c", step?.run ?? "exit 2"], {
    env: { PATH: process.env.PATH, ...step?.env, RESULTS: results },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim() };
};

/** Runs the gate step with these job results; every unnamed job succeeded. */
const gate = (results: Record<string, string | undefined>) =>
  runGate(JSON.stringify(Object.fromEntries(jobs.map((id) => [id, { result: results[id] ?? "success", outputs: {} }]))));

test("the gate passes when every job succeeded or a path-filtered job was skipped", async () => {
  expect(await gate({})).toEqual({ code: 0, stderr: "" });
  expect(await gate(Object.fromEntries(pathFiltered.map((id) => [id, "skipped"])))).toEqual({ code: 0, stderr: "" });
});

test("the gate fails on every other result and names the jobs", async () => {
  for (const result of ["failure", "cancelled", "abandoned", "timed_out", "neutral", ""]) {
    expect(await gate({ integration: result })).toEqual({ code: 1, stderr: `Jobs that did not pass: integration (${result})` });
  }
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

test("ci.yml passes the rule", async () => {
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
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
      "jobs.gate.needs is missing ui",
      "check may be skipped only by a path filter: its `if:` must read needs.changes.outputs and it must need changes",
      "lint may be skipped only by a path filter: its `if:` must read needs.changes.outputs and it must need changes",
      "MAY_SKIP lists check, which it must not",
      "MAY_SKIP lists lint, which it must not",
      "MAY_SKIP lists setup, which it must not",
      "site needs ui, which may be skipped; a cascading skip would hide in the gate",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
