import { test as bunTest, expect } from "bun:test";
import { CODE_CHECK_LIMITS, CodeCheckResultSchema, type CodeTestLimits } from "@k2b/cloud/code";
import type { RunnerJobLease } from "@k2b/cloud/code/runner";
import { allocateRunnerIdentities } from "../src/identities";
import { executeRunnerJob } from "../src/jobs";
import { config } from "./fixtures";
import { ACCEPTANCE_SOURCE, now, sdk, target } from "./test-kit.fixtures";

const test = bunTest.skipIf(process.getuid?.() !== 0);
const limits: CodeTestLimits = {
  requestBytes: CODE_CHECK_LIMITS.requestBytes,
  outputBytes: CODE_CHECK_LIMITS.outputBytes,
  cases: 10,
  runs: 10,
  calls: 10,
  wallClockMs: 10000,
};
function lease(kind: RunnerJobLease["kind"], input: string): RunnerJobLease {
  return {
    kind,
    jobId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    leaseKey: "a".repeat(64),
    deadlineAt: now + 30000,
    leaseExpiresAt: now + 15000,
    heartbeatMs: 5000,
    inputBytes: Buffer.byteLength(input),
    outputBytes: CODE_CHECK_LIMITS.outputBytes,
  };
}
test("C13b real isolated checker returns permission locations and fake test role executes without effects", async () => {
  const request = {
    kind: "check",
    request: { files: { "code.ts": ACCEPTANCE_SOURCE }, entry: "code.ts", sdk, aiOperations: [], limits: CODE_CHECK_LIMITS },
  };
  const input = JSON.stringify(request);
  const checked = await executeRunnerJob(lease("check", input), input, config, AbortSignal.timeout(20000));
  expect(checked.kind).toBe("check");
  if (checked.kind !== "check") throw new Error("Missing checker result");
  const result = CodeCheckResultSchema.parse(checked.result);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.permissions).toContainEqual(expect.objectContaining({ operation: "spaces.task.create", file: "code.ts", line: 2 }));
  const execution = {
    mode: "test",
    bundle: result.bundle,
    manifest: result.manifest,
    sdk,
    cases: [
      {
        file: "test/one.json",
        fixture: {
          version: 1,
          name: "fake only",
          now,
          seed: 42,
          mocks: [{ operation: "spaces.task.create", target, replies: [{ ok: true, data: { id: "fake-task" } }] }],
          runs: [{ entrypoint: "weekly", expect: { ok: true, calls: [{ operation: "spaces.task.create" }] } }],
        },
      },
    ],
  };
  const testInput = JSON.stringify({ kind: "test", execution, limits });
  const tested = await executeRunnerJob(lease("test", testInput), testInput, config, AbortSignal.timeout(15000));
  expect(tested.kind).toBe("test");
  if (tested.kind === "test")
    expect(tested.result).toMatchObject({
      ok: true,
      cases: [{ runs: [{ calls: [{ result: { ok: true, data: { id: "fake-task" } } }] }] }],
    });
  const simulateInput = JSON.stringify({ kind: "simulate", execution: { ...execution, mode: "simulate" }, limits });
  expect(await executeRunnerJob(lease("simulate", simulateInput), simulateInput, config, AbortSignal.timeout(15000))).toMatchObject({
    kind: "simulate",
    result: { ok: true, mode: "simulate" },
  });
}, 50000);
test("C13b job init has private proc/tmp and inherits no credentials or network", async () => {
  const child = Bun.spawn(
    [
      "/app/job-isolate",
      String(allocateRunnerIdentities(65536)),
      String(2 * CODE_CHECK_LIMITS.requestBytes),
      process.execPath,
      "--no-env-file",
      "/app/job-probe.js",
    ],
    { env: { CLOUD_APP_KEY: "fixture-secret-must-not-cross" }, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ pid: 1, parent: 0, tmpOwner: 0, environment: [], processes: ["1"], network: false });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10000);
