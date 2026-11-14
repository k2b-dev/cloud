import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { CodeTestExecution } from "@k2b/cloud/code";
import { CodeTestResultSchema, codeSdkHash, generateCodeSdk } from "@k2b/cloud/code";
import { createCodeTestExecutor } from "../src/test-kit";
import { config } from "./fixtures";

const bundle = "export async function run() {}";
const hash = createHash("sha256").update(bundle).digest("hex");
const sdk = generateCodeSdk([], { mode: "code_run" });
const request: CodeTestExecution = {
  mode: "simulate",
  bundle,
  sdk,
  manifest: {
    version: 1,
    entrypoints: [{ kind: "manual", entrypoint: "run", cron: null, file: "code.ts", line: 1 }],
    permissions: [],
    ai: false,
    hashes: { source: hash, sdk: codeSdkHash(sdk), bundle: hash },
  },
  cases: [
    {
      file: null,
      fixture: { version: 1, name: "one", now: Date.UTC(2030, 0, 2), seed: 42, mocks: [], runs: [{ entrypoint: "run", input: null }] },
    },
  ],
};
const limits = { requestBytes: 1024 * 1024, outputBytes: 1024, cases: 1, runs: 1, calls: 1, wallClockMs: 1000 };

test("runner refuses mismatched bundles, oversized requests and excess cases before creating a sandbox", async () => {
  const execute = createCodeTestExecutor(config, limits);
  expect(await execute({ ...request, bundle: `${bundle}\n` })).toMatchObject({ error: "code_test_bundle_mismatch" });
  expect(await execute({ ...request, sdk: generateCodeSdk([], { mode: "personal" }) })).toMatchObject({ error: "code_test_sdk_mismatch" });
  expect(await execute({ ...request, cases: [...request.cases, ...request.cases] })).toMatchObject({ error: "code_test_case_limit" });
  expect(await createCodeTestExecutor(config, { ...limits, requestBytes: 1 })(request)).toMatchObject({ error: "code_test_request_limit" });
});
test("cancellation is visible and requires no production bridge or runner credentials", async () => {
  expect(await createCodeTestExecutor(config, limits)(request, AbortSignal.abort())).toMatchObject({
    error: "code_test_cancelled",
    mode: "simulate",
    cases: [],
  });
});

test("standalone role preserves simulate mode in a schema-valid process-placement refusal", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/code-test.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {},
  });
  child.stdin.write(JSON.stringify({ execution: request, config, limits }));
  child.stdin.end();
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(CodeTestResultSchema.parse(JSON.parse(stdout))).toMatchObject({
      mode: "simulate",
      error: "code_test_isolation_required",
      cases: [],
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
