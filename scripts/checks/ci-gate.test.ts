import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../workspace";
import { gateStep, rule } from "./ci-gate";

const workflow = Bun.YAML.parse(await readFile(join(workspaceRoot, ".github", "workflows", "ci.yml"), "utf8"));
const step = gateStep(workflow);
const jobs: string[] = workflow.jobs.gate.needs;
const pathFiltered = step?.env?.MAY_SKIP?.split(" ") ?? [];

/** Runs the gate step of ci.yml with these job results, like the runner does. */
const gate = async (results: Record<string, string | undefined>) => {
  const needs = Object.fromEntries(jobs.map((id) => [id, { result: results[id] ?? "success", outputs: {} }]));
  const child = Bun.spawn(["bash", "-c", step?.run ?? "exit 2"], {
    env: { PATH: process.env.PATH, ...step?.env, RESULTS: JSON.stringify(needs) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim() };
};

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

test("ci.yml passes the rule", async () => {
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
});

test("reports a gate that misses a job, an unlisted path filter, or a cascading skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ci-gate-"));
  try {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  changes: {}",
        "  docs: { needs: changes, if: \"needs.changes.outputs.docs == 'true'\" }",
        "  ui: { needs: changes, if: \"needs.changes.outputs.ui == 'true'\" }",
        "  site: { needs: [changes, ui], if: \"needs.changes.outputs.site == 'true'\" }",
        "  gate:",
        "    needs: [changes, docs, site]",
        "    steps:",
        "      - env: { MAY_SKIP: docs ui site setup }",
      ].join("\n"),
    );
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => finding.message)).toEqual([
      "jobs.gate must run with `if: always()`",
      "jobs.gate.needs is missing ui",
      "MAY_SKIP lists setup, which it must not",
      "site needs ui, which may be skipped; a cascading skip would hide in the gate",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
