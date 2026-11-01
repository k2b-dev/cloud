import { test as bunTest, expect } from "bun:test";
import { createHash } from "node:crypto";
import { type CodeTestCase, type CodeTestExecution, CodeVersionManifestSchema, codeSdkHash, generateCodeSdk } from "@k2b/cloud/code";
import { z } from "zod";
import { createCodeTestExecutor } from "../src/test-kit";
import { config } from "./fixtures";
import { ACCEPTANCE_SOURCE, now, sdk, target } from "./test-kit.fixtures";

const test = bunTest.skipIf(process.getuid?.() !== 0);
const limits = { requestBytes: 1024 * 1024, outputBytes: 64 * 1024, cases: 10, runs: 10, calls: 10, wallClockMs: 10_000 };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function execution(source: string, cases: CodeTestCase[]): Promise<CodeTestExecution> {
  if (source === ACCEPTANCE_SOURCE) {
    // Built by the real C16 worker during the image build, including the entries guard and string export.
    const checked = z
      .object({ bundle: z.string(), manifest: CodeVersionManifestSchema })
      .parse(await Bun.file(`${import.meta.dir}/test-kit-checked.json`).json());
    return { mode: "test", sdk, cases: cases.map((fixture, i) => ({ file: `test/case-${i}.json`, fixture })), trace: true, ...checked };
  }
  // Other probes use a small SDK wrapper. They never execute Code in the Bun supervisor.
  const built = await Bun.build({
    entrypoints: ["code:host"],
    target: "browser",
    format: "esm",
    plugins: [
      {
        name: "fixture",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => ({ path: args.path, namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents:
              args.path === "@sdk"
                ? sdk.runtime
                : args.path === "code:entry"
                  ? source
                  : 'import { __codeSdk } from "@sdk"; export async function weekly(input, cloud) { __codeSdk.bind(cloud); await import("code:entry"); return __codeSdk.run("weekly"); }',
          }));
        },
      },
    ],
  });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text();
  return {
    mode: "test",
    bundle,
    sdk,
    cases: cases.map((fixture, i) => ({ file: `test/case-${i}.json`, fixture })),
    trace: true,
    manifest: {
      version: 1,
      entrypoints: [{ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * *", file: "code.ts", line: 1 }],
      permissions: [],
      ai: false,
      hashes: { source: sha(source), sdk: codeSdkHash(sdk), bundle: sha(bundle) },
    },
  };
}
const fixture = (): CodeTestCase => ({
  version: 1,
  name: "invoice task replay",
  now,
  seed: 42,
  mocks: [{ operation: "spaces.task.create", target, replies: [{ ok: true, data: { id: "task-created" } }] }],
  runs: [false, true].map((replayed) => ({
    entrypoint: "weekly",
    input: null,
    expect: {
      ok: true,
      calls: [{ operation: "spaces.task.create", replayed, result: { ok: true, data: { id: "task-created" } } }],
    },
  })),
});
const schedule = (body: string) => `import { app, owner } from "@sdk";
app.schedule("0 8 * * *", async () => { ${body} }, { name: "weekly" }); export default app;`;

test("acceptance: schedule creates a Space task, then replays the old result with the same key", async () => {
  const request = await execution(ACCEPTANCE_SOURCE, [fixture()]);
  const result = await createCodeTestExecutor(config, limits)(request);
  expect(result).toMatchObject({ ok: true, error: null, cases: [{ ok: true, runs: [{ ok: true }, { ok: true }] }] });
  expect(result.cases[0]?.runs[0]?.calls[0]?.call.input).toEqual({ title: String(now) });
  expect(result.cases[0]?.runs[1]?.calls[0]?.replayed).toBe(true);
  expect(result.trace?.map((row) => row.event)).toEqual(["start", "complete", "start", "complete"]);
}, 15_000);

test("missing mock is a clear case failure even if author code catches the refusal", async () => {
  const value = fixture();
  value.mocks = [];
  value.runs = [value.runs[0]!];
  const request = await execution(schedule('try { await owner.task.create({ title: "x", idempotencyKey: "invoice:one" }); } catch {}'), [
    value,
  ]);
  const result = await createCodeTestExecutor(config, limits)(request);
  expect(result).toMatchObject({ ok: false, cases: [{ ok: false, runs: [{ error: "code_test_missing_mock" }] }] });
}, 15_000);

test("same sandbox denies network and environment; clock and Math.random repeat across cases", async () => {
  const value = fixture();
  value.runs = [{ entrypoint: "weekly", input: null }];
  const source = schedule(`
    let network = "open"; try { await fetch("http://127.0.0.1:1"); } catch { network = "blocked"; }
    if (Date() !== new Date(Date.now()).toString()) throw new Error("date_call_changed");
    if (network !== "blocked" || (typeof process !== "undefined" && Object.keys(process.env).length)) throw new Error("isolation_failed");
    await owner.task.create({ title: [Date.now(), new Date().getTime(), Math.random(), network].join(":"), idempotencyKey: "isolated" });
  `);
  const request = await execution(source, [value, { ...value, name: "isolated second case" }]);
  const result = await createCodeTestExecutor(config, limits)(request);
  expect(result.ok).toBe(true);
  const titles = result.cases.map((row) => row.runs[0]?.calls[0]?.call.input);
  expect(titles[0]).toEqual(titles[1]);
  expect(titles[0]).toEqual({ title: `${now}:${now}:0.2523451747838408:blocked` });
}, 15_000);

test("call, wall-clock and output budgets terminate visibly and reap the worker", async () => {
  const value = fixture();
  value.runs = [{ entrypoint: "weekly", input: null }];
  const request = await execution(
    schedule('for (let i = 0; i < 3; i++) await owner.task.create({ title: "x", idempotencyKey: "same" });'),
    [value],
  );
  expect(await createCodeTestExecutor(config, { ...limits, calls: 1 })(request)).toMatchObject({
    ok: false,
    cases: [{ runs: [{ error: "code_test_call_limit" }] }],
  });
  expect(await createCodeTestExecutor(config, { ...limits, outputBytes: 256 })(request)).toMatchObject({
    ok: false,
    error: "code_test_output_limit",
    cases: [],
  });
  const waiting = await execution(schedule("await new Promise(() => {});"), [value]);
  expect(await createCodeTestExecutor(config, { ...limits, wallClockMs: 500 })(waiting)).toMatchObject({ ok: false });
}, 15_000);

test("simulate executes fixture data with no effects and preserves the versioned JSON envelope", async () => {
  const value = fixture();
  value.runs = [value.runs[0]!];
  const request = await execution(schedule('await owner.task.create({ title: "simulated", idempotencyKey: "simulation" });'), [value]);
  request.mode = "simulate";
  expect(await createCodeTestExecutor(config, limits)(request)).toMatchObject({ version: 1, mode: "simulate", ok: true });
}, 15_000);

test("simulate passes fixture input to a manual entrypoint and returns its JSON value", async () => {
  const manualSdk = generateCodeSdk([], { mode: "code_run" });
  const bundle = "export async function run(input) { return { count: input.count + 1, at: Date.now() }; }";
  const request: CodeTestExecution = {
    mode: "simulate",
    bundle,
    sdk: manualSdk,
    manifest: {
      version: 1,
      entrypoints: [{ kind: "manual", entrypoint: "run", cron: null, file: "code.ts", line: 1 }],
      permissions: [],
      ai: false,
      hashes: { source: sha(bundle), bundle: sha(bundle), sdk: codeSdkHash(manualSdk) },
    },
    cases: [
      {
        file: null,
        fixture: {
          version: 1,
          name: "manual input",
          now,
          seed: 42,
          mocks: [],
          runs: [{ entrypoint: "run", input: { count: 3 }, expect: { ok: true, value: { count: 4, at: now }, calls: [] } }],
        },
      },
    ],
  };
  expect(await createCodeTestExecutor(config, limits)(request)).toMatchObject({
    mode: "simulate",
    ok: true,
    cases: [{ file: null, runs: [{ value: { count: 4, at: now } }] }],
  });
}, 15_000);
