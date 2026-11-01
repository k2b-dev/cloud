import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CodeCheckHost, type CodeTestCase, checkCode, generateCodeSdk } from "@k2b/cloud/code";
import { z } from "zod";
import { type CodeTestingHost, simulateCode, testCode } from "./testing";

let directory: string;
let checker: CodeCheckHost;
let executions = 0;
const limits = { requestBytes: 2 * 1024 * 1024, outputBytes: 64 * 1024, cases: 10, runs: 10, calls: 10, wallClockMs: 10_000 };
const sdk = generateCodeSdk(
  [
    compileCapabilityManifest("work-shop", {
      protocolVersion: 2,
      types: { workshop: { title: "Workshop", description: "A fixture workshop." } },
      queries: {
        "stock.list": {
          title: "Stock",
          description: "Fixture stock.",
          target: "workshop",
          openWorld: false,
          input: z.object({}).strict(),
          data: z.object({}).strict(),
          run: () => {
            throw new Error("not_executable");
          },
        },
      },
      actions: {
        "item.create": {
          title: "Create",
          description: "Fixture creation.",
          target: "workshop",
          openWorld: false,
          destructive: false,
          idempotency: "required",
          input: z.object({ title: z.string().describe("Fixture title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          run: () => {
            throw new Error("not_executable");
          },
        },
      },
    }),
  ],
  { mode: "resource", owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner" } } },
);
const fixture: CodeTestCase = {
  version: 1,
  name: "weekly",
  now: Date.UTC(2030, 0, 2),
  seed: 42,
  mocks: [],
  runs: [{ entrypoint: "weekly", input: null }],
};
const code = (body: string) => ({
  sdk,
  aiOperations: [],
  entry: "code.ts",
  files: {
    "code.ts": `import { app, owner, work_shop } from "@sdk"; app.schedule("0 8 * * *", async () => { ${body} }, { name: "weekly" }); export default app;`,
  },
});
const host = (): CodeTestingHost => ({
  check: (request, signal) => checkCode(request, checker, signal),
  limits,
  execute: async (request) => {
    executions++;
    expect(request.manifest.entrypoints[0]?.entrypoint).toBe("weekly");
    expect(request.bundle).toContain("weekly");
    expect(request.cases).toEqual([{ file: request.mode === "test" ? "test/weekly.json" : null, fixture }]);
    return { version: 1, mode: request.mode, ok: true, error: null, diagnostics: [], cases: [] };
  },
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cloud-c17-core-"));
  const isolate = join(directory, "checker-isolate");
  const compiler = Bun.spawn(
    ["cc", "-O2", "-Wall", "-Wextra", "-Werror", resolve(import.meta.dir, "../../../runner/native/checker-isolate.c"), "-o", isolate],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  checker = {
    isolate,
    bun: process.execPath,
    worker: resolve(import.meta.dir, "../../../cloud/scripts/code-check-worker.ts"),
    compiler: join(
      dirname(
        Bun.resolveSync(
          `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
          dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
        ),
      ),
      "lib/tsc",
    ),
  };
});
afterAll(async () => {
  await unlink(join(directory, "checker-isolate"));
  await rmdir(directory);
});

test("Core checks source before sending immutable bundles and fixtures to the fake-only Runner role", async () => {
  expect(
    await testCode(
      {
        code: code('await owner.item.create({ title: "Hello", idempotencyKey: "fixed" });'),
        tests: { "test/weekly.json": JSON.stringify(fixture) },
      },
      host(),
    ),
  ).toMatchObject({ ok: true, mode: "test" });
});
test("dynamic resource targets fail the authoritative check without executing a test", async () => {
  const before = executions;
  const result = await testCode(
    {
      code: code("const id: string = String(Date.now()); await work_shop.workshop(id).stock.list({});"),
      tests: { "test/weekly.json": JSON.stringify(fixture) },
    },
    host(),
  );
  expect(result).toMatchObject({ ok: false, error: "code_test_check_failed" });
  expect(result.diagnostics.some((row) => row.code === "code_dynamic_target")).toBe(true);
  expect(executions).toBe(before);
});
test("simulate checks the same source and passes one fixture invocation", async () => {
  expect(await simulateCode({ code: code(""), fixture }, host())).toMatchObject({ ok: true, mode: "simulate" });
});
test("bad JSON, executable test files, empty cases and oversize inputs fail before the checker or Runner", async () => {
  const before = executions;
  const invalid: Record<string, string>[] = [{ "test/weekly.json": "{" }, { "test/weekly.ts": "throw 1" }, {}];
  for (const tests of invalid) {
    expect((await testCode({ code: code(""), tests }, host())).ok).toBe(false);
  }
  expect(
    await testCode(
      { code: code(""), tests: { "test/weekly.json": JSON.stringify(fixture) } },
      { ...host(), limits: { ...limits, requestBytes: 1 } },
    ),
  ).toMatchObject({ error: "code_test_request_limit" });
  expect(executions).toBe(before);
});
