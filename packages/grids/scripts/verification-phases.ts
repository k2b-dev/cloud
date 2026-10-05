import { existsSync } from "node:fs";
import { join } from "node:path";
import { behaviorTest, listTestFiles } from "../../../scripts/run-tests";

export type VerificationPhase = { name: string; files: string[]; flags: string[]; pdftotext?: boolean };

/**
 * Every certification phase in run order, with absolute file paths. Grids test files that need
 * a process of their own are listed by name; browser behavior tests (`*.behavior.test.{ts,tsx}`,
 * the root test runner's convention) run in `dom`; every other Grids test file runs in
 * `database-and-standard`. Throws when a Grids test file would run in no phase or in several.
 * Kept apart from ./verification.ts, which tests and crash workers import, so they do not load the test runner.
 */
export const verificationPhases = async (root: string): Promise<VerificationPhase[]> => {
  const packageRoot = join(root, "packages/grids");
  const grids = (...files: string[]) => files.map((file) => join(packageRoot, file));
  const outbox = grids("src/service/record-event-outbox.integration.test.ts");
  const workflowConcurrency = grids("src/service/workflow-concurrency.integration.test.ts");
  const sync = grids("src/service/record-events.integration.test.ts", "src/service/record-event-retry.integration.test.ts");
  const ownSync = grids("src/service/evidence-exports.integration.test.ts");
  const bundleChecks = grids("src/frontend/_components/dialogs/AuditPolicyDialog.bundle.test.ts");
  const pdf = grids("src/service/document-query-pdf.integration.test.ts");
  const crashes = grids("src/service/document-workflow-crash.integration.test.ts");
  const recovery = grids("src/service/record-event-runtime.integration.test.ts", "src/service/evidence-cleanup.integration.test.ts");
  const all = (await listTestFiles(packageRoot)).map((file) => join(packageRoot, file));
  const dom = all.filter((file) => behaviorTest.test(file));
  const separate = new Set([
    ...outbox,
    ...workflowConcurrency,
    ...sync,
    ...ownSync,
    ...bundleChecks,
    ...pdf,
    ...crashes,
    ...recovery,
    ...dom,
  ]);
  const phases: VerificationPhase[] = [
    // The outbox reconciler claims database-wide work, so test it before other suites enqueue events.
    // This suite owns its Sync lifecycle for the live burst test.
    { name: "outbox", files: outbox, flags: [] },
    {
      name: "workflow-concurrency",
      files: workflowConcurrency,
      flags: ["--timeout", "120000", "--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
    },
    {
      name: "workflow-kernel",
      files: [
        ...new Bun.Glob("packages/cloud/src/workflows/store/*.integration.test.ts").scanSync(root),
        "packages/cloud/src/workflows/store/worker-pool.test.ts",
        ...new Bun.Glob("packages/cloud/src/workflows/runtime/*.test.ts").scanSync(root),
      ]
        .sort()
        .map((file) => join(root, file)),
      // packages/cloud runs these files with --isolate, so a module mock in one of them must not leak into the next.
      flags: ["--isolate", "--timeout", "30000"],
    },
    {
      name: "database-and-standard",
      files: all.filter((file) => !separate.has(file)),
      // These suites include multi-step migrations and history baselines;
      // their timeout is not a single-request latency budget.
      flags: ["--timeout", "30000", "--preload", "./packages/grids/scripts/verify-sync-preload.ts"],
      pdftotext: true,
    },
    { name: "sync", files: sync, flags: [] },
    { name: "evidence-exports", files: ownSync, flags: ["--timeout", "30000"] },
    // Keep browser bundling isolated from process-global test plugins.
    { name: "browser-bundle", files: bundleChecks, flags: [] },
    { name: "pdf", files: pdf, flags: [], pdftotext: true },
    { name: "process-crashes", files: crashes, flags: [] },
    { name: "recovery-and-cleanup", files: recovery, flags: [] },
    { name: "dom", files: dom, flags: ["--isolate", "--conditions=browser", "--preload", "./packages/ui/test/solid-dom-preload.ts"] },
  ];
  assertPhaseCoverage(all, phases);
  return phases;
};

/** Fails unless every one of `testFiles` runs in exactly one phase, no phase is empty, and every listed file exists. */
export const assertPhaseCoverage = (testFiles: string[], phases: { name: string; files: string[] }[]): void => {
  const problems: string[] = [];
  const runs = new Map(testFiles.map((file) => [file, [] as string[]]));
  for (const phase of phases) {
    if (!phase.files.length) problems.push(`phase ${phase.name} has no test files`);
    for (const file of phase.files) {
      const names = runs.get(file);
      if (names) names.push(phase.name);
      else if (!existsSync(file)) problems.push(`${file} is listed in phase ${phase.name} but does not exist`);
    }
  }
  for (const [file, names] of runs) {
    if (names.length !== 1) problems.push(`${file} runs in ${names.length ? `phases ${names.join(", ")}` : "no phase"}`);
  }
  if (problems.length) throw new Error(`Grids verification phases must run every test file exactly once:\n${problems.join("\n")}`);
};
