import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { capabilityHash } from "../_internal/capability-schemas";
import { type CodeCheckHost, checkCode } from "./checker";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, CodeVersionManifestSchema } from "./checker-contract";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

let directory: string;
let host: CodeCheckHost;
const sdk = generateCodeSdk([sdkFixture()], {
  mode: "resource",
  owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } },
});
const base: Omit<CodeCheckRequest, "files" | "entry"> = { sdk, aiOperations: [] };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cloud-c16-test-"));
  const isolate = join(directory, "checker-isolate");
  const compile = Bun.spawn(
    ["cc", "-O2", "-Wall", "-Wextra", "-Werror", resolve(import.meta.dir, "../../../runner/native/checker-isolate.c"), "-o", isolate],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  host = {
    isolate,
    compiler: join(
      dirname(
        Bun.resolveSync(
          `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
          dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
        ),
      ),
      "lib/tsc",
    ),
    worker: resolve(import.meta.dir, "../../scripts/code-check-worker.ts"),
    bun: process.execPath,
  };
  const image = join(directory, "image");
  await mkdir(join(image, "node_modules/@typescript"), { recursive: true });
  for (const [entry, outfile] of [
    ["code-check.ts", "checker.js"],
    ["code-check-worker.ts", "check-worker.js"],
  ]) {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../../scripts", entry!)],
      target: "bun",
      external: ["@typescript/typescript6"],
    });
    expect(built.success).toBe(true);
    await writeFile(join(image, outfile!), await built.outputs[0]!.text());
  }
  await cp(
    dirname(Bun.resolveSync("@typescript/typescript6/package.json", import.meta.dir)),
    join(image, "node_modules/@typescript/typescript6"),
    { recursive: true },
  );
  await cp(
    dirname(
      Bun.resolveSync("@typescript/old/package.json", dirname(Bun.resolveSync("@typescript/typescript6/package.json", import.meta.dir))),
    ),
    join(image, "node_modules/@typescript/old"),
    { recursive: true },
  );
  await cp(dirname(host.compiler), join(image, "compiler"), { recursive: true });
  await copyFile(host.isolate, join(image, "checker-isolate"));
  await chmod(join(image, "compiler/tsc"), 0o755);
  await chmod(join(image, "checker-isolate"), 0o755);
});
afterAll(async () => {
  async function clean(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await clean(child);
      else await unlink(child);
    }
    await rmdir(path);
  }
  await clean(directory);
});
const check = (source: string, extra: Partial<CodeCheckRequest> = {}) =>
  checkCode({ ...base, entry: "code.ts", files: { "code.ts": source }, ...extra }, host);
const schedule = (body: string) =>
  `import { app, owner, work_shop } from "@sdk";\napp.schedule("0 8 * * 1", async () => {\n${body}\n}, { name: "weekly" });\nexport default app;`;

test("checks imported literal constants, refs and finite unions, with source lines, new/existing status, AI and hashes", async () => {
  const result = await check("", {
    files: {
      "code.ts": `import { app, owner, work_shop } from "@sdk";\nimport { target } from "./ids";\nconst h = work_shop.workshop(target);\napp.schedule("0 8 * * 1", async () => {\nawait h.item.create({ title: "Hello", idempotencyKey: "weekly:fixed" });\nawait owner.item.move({ itemId: "item-one", destination: h });\n}, { name: "weekly" });\nexport default app;`,
      "ids.ts": 'export const target = "imported-shop";',
    },
    aiOperations: ["work-shop.item.create"],
    existingPermissions: [{ operation: "work-shop.item.create", target: { type: "work-shop.workshop", id: "imported-shop" } }],
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.manifest.entrypoints).toEqual([{ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1", file: "code.ts", line: 4 }]);
  expect(result.permissions).toEqual([
    {
      operation: "work-shop.item.create",
      target: { type: "work-shop.workshop", id: "imported-shop" },
      file: "code.ts",
      line: 5,
      status: "existing",
    },
    { operation: "work-shop.item.move", target: { type: "work-shop.workshop", id: "owner-shop" }, file: "code.ts", line: 6, status: "new" },
    {
      operation: "work-shop.item.move",
      target: { type: "work-shop.workshop", id: "imported-shop" },
      file: "code.ts",
      line: 6,
      status: "new",
    },
  ]);
  expect(result.manifest.ai).toBe(true);
  expect(CodeVersionManifestSchema.parse(result.manifest)).toEqual(result.manifest);
  expect(result.manifest.hashes.bundle).toBe(createHash("sha256").update(result.bundle).digest("hex"));
  // Execute only the successfully checked bundle in this test. The checker never executes it.
  await writeFile(join(directory, "bundle.mjs"), result.bundle);
  const module = await import(join(directory, "bundle.mjs"));
  const calls: Array<{ operation: string; input: unknown }> = [];
  await module.weekly(null, {
    call: async (operation: string, input: unknown) => {
      calls.push({ operation, input });
      return {};
    },
  });
  expect(calls.map((c) => c.operation)).toEqual(["work-shop.item.create", "work-shop.item.move"]);
  expect(calls[0]?.input).toMatchObject({ call: { target: { type: "work-shop.workshop", id: "imported-shop" } } });
});

test("enumerates const tuple targets and permits dynamic personal IDs", async () => {
  const result = await check(
    schedule('const targets = ["first", "second"] as const;\nfor (const id of targets) await work_shop.workshop(id).stock.list({});'),
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.manifest.permissions.map((p) => p.target?.id)).toEqual(["first", "second"]);
});

test("records a dynamic personal target without inventing a literal", async () => {
  const personal = generateCodeSdk([sdkFixture()], { mode: "personal" });
  const result = await check(
    schedule('const id: string = String("dynamic"); await work_shop.workshop(id).stock.list({});').replace(", owner,", ","),
    { sdk: personal },
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.manifest.permissions[0]?.target).toEqual({ type: "work-shop.workshop", id: null });
});

test("preserves unnamed schedule order across imported modules and bundles nested entry paths", async () => {
  const result = await check("", {
    entry: "nested/code.ts",
    files: {
      "nested/code.ts": 'import "./first"; import { app } from "@sdk"; app.schedule("0 9 * * *", () => {});',
      "nested/first.ts": 'import { app } from "@sdk"; app.schedule("0 8 * * *", () => {});',
      "unused.ts": 'import { app } from "@sdk"; app.schedule("0 10 * * *", () => {});',
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (result.ok)
    expect(result.manifest.entrypoints.map((e) => [e.entrypoint, e.cron])).toEqual([
      ["schedule:0", "0 8 * * *"],
      ["schedule:1", "0 9 * * *"],
    ]);
});

test("the built checker role runs with the exact image file layout and an empty environment", async () => {
  const child = Bun.spawn([host.bun, "--no-env-file", join(directory, "image/checker.js")], {
    cwd: directory,
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ ...base, entry: "code.ts", files: { "code.ts": schedule("await owner.stock.list({});") } }));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, manifest: { entrypoints: [{ entrypoint: "weekly" }] } });
});

test("an entry imported back through a cycle is evaluated once", async () => {
  const result = await check("", {
    files: {
      "code.ts": 'import "./cycle"; import { app } from "@sdk"; app.schedule("0 8 * * *", () => {}, {name: "cycle"});',
      "cycle.ts": 'import "./code";',
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  await writeFile(join(directory, "cycle.mjs"), result.bundle);
  const module = await import(join(directory, "cycle.mjs"));
  await module.cycle(null, { call: async () => null });
});

test.each(["jeden Montag", "61 8 * * *", "0 8 31 2 *"])("rejects invalid cron %s", async (cron) => {
  const result = await check(`import {app} from "@sdk"; app.schedule(${JSON.stringify(cron)}, () => {});`);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_invalid_cron" })]),
  });
});

test("code_run requires a default function and produces a callable run export", async () => {
  const once = generateCodeSdk([sdkFixture()], { mode: "code_run" });
  const result = await check('import { work_shop } from "@sdk"; export default async () => work_shop.workshop("one").stock.list({});', {
    sdk: once,
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  await writeFile(join(directory, "once.mjs"), result.bundle);
  const module = await import(join(directory, "once.mjs"));
  expect(await module.run(null, { call: async () => ({ rows: [] }) })).toEqual({ rows: [] });
});

test("code_run rejects a missing default function", async () => {
  const once = generateCodeSdk([sdkFixture()], { mode: "code_run" });
  const result = await check("export default 42;", { sdk: once });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_run_entrypoint" })]),
  });
});

test("SDK hashes survive key reordering and source hashes bind the chosen entry", async () => {
  const files = { "code.ts": schedule("await (owner.stock.list)({});"), "other.ts": "export {};" };
  const reordered = { manifest: sdk.manifest, runtime: sdk.runtime, declarations: sdk.declarations };
  const result = await check("", { files, sdk: reordered });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.manifest.hashes.sdk).toBe(capabilityHash(sdk));
  expect(result.manifest.hashes.source).toBe(
    createHash("sha256")
      .update(JSON.stringify({ entry: "code.ts", files: Object.entries(files) }))
      .digest("hex"),
  );
});

test("type-only imports do not reorder runtime schedule registration", async () => {
  const result = await check("", {
    files: {
      "code.ts": 'import type {T} from "./b"; import "./a"; import "./b"; const value:T = {};',
      "a.ts": 'import {app} from "@sdk"; app.schedule("0 8 * * *", () => {});',
      "b.ts": 'import {app} from "@sdk"; export interface T {} app.schedule("0 9 * * *", () => {});',
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.manifest.entrypoints.map((e) => [e.entrypoint, e.cron])).toEqual([
    ["schedule:0", "0 8 * * *"],
    ["schedule:1", "0 9 * * *"],
  ]);
  await writeFile(join(directory, "order.mjs"), result.bundle);
  const module = await import(join(directory, "order.mjs"));
  await module["schedule:0"](null, { call: async () => null });
});

test("unused value imports preserve schedule order even when a later module also imports the dependency", async () => {
  const result = await check("", {
    files: {
      "code.ts": 'import {x} from "./b"; import "./a"; import "./c";',
      "a.ts": 'import {app} from "@sdk"; app.schedule("0 8 * * *", () => {});',
      "b.ts": 'import {app} from "@sdk"; export const x = 1; app.schedule("0 9 * * *", () => {});',
      "c.ts": 'import "./b";',
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.manifest.entrypoints.map((e) => [e.entrypoint, e.cron])).toEqual([
    ["schedule:0", "0 9 * * *"],
    ["schedule:1", "0 8 * * *"],
  ]);
  await writeFile(join(directory, "unused-order.mjs"), result.bundle);
  const module = await import(join(directory, "unused-order.mjs"));
  await module["schedule:0"](null, { call: async () => null });
});

for (const [label, statement] of [
  ["empty import", 'import {} from "./b";'],
  ["inline type export", 'export {type X} from "./b";'],
  ["inline type import", 'import {type X} from "./b";'],
  ["typeof-only value import", 'import {x} from "./b"; type T = typeof x;'],
])
  test(`preserves module evaluation for ${label}`, async () => {
    const result = await check("", {
      files: {
        "code.ts": statement!,
        "b.ts": 'import {app} from "@sdk"; export const x = 1; export interface X {} app.schedule("0 9 * * *", () => {});',
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    await writeFile(join(directory, `${label}.mjs`), result.bundle);
    const module = await import(join(directory, `${label}.mjs`));
    await module["schedule:0"](null, { call: async () => null });
  });

test("types must use explicit import type so runtime modules stay predictable", async () => {
  const result = await check("", {
    sdk: generateCodeSdk([], { mode: "code_run" }),
    files: {
      "code.ts": 'import {Cfg} from "./types"; const value:Cfg = {}; export default () => value;',
      "types.ts": "export interface Cfg {}",
    },
  });
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "TS1484" })]),
  });
});

test("regex literals cannot hide a real type-suppression comment", async () => {
  const result = await check(schedule('const r = /"/; // @ts-ignore\nconst n:number = "x";'));
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_type_suppression" })]),
  });
});

test("strings containing type-suppression examples remain ordinary data", async () => {
  const result = await check(schedule('const example = "// @ts-ignore";'));
  expect(result).toMatchObject({ ok: true });
});

test("rejects dynamic resource targets with an actionable diagnostic", async () => {
  const result = await check(
    schedule('const id: string = String("dynamic");\nawait work_shop.workshop(id).item.create({ title: "x", idempotencyKey: "k" });'),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_dynamic_target", line: 4, message: expect.stringContaining("Konstante") }),
  );
});

test.each([
  ["outside.change", "code_code_false"],
  ["stock.export", "code_stream"],
])("rejects omitted operation %s", async (method, code) => {
  const result = await check(schedule(`await owner.${method}({});`));
  expect(result).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) });
});

test("rejects duplicate event/place subscriptions even though events also report Phase 3", async () => {
  const result = await check(
    `import { app, owner, work_shop } from "@sdk";\napp.on("work-shop.changed", () => {});\napp.on(owner, "work-shop.changed", () => {});`,
  );
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "code_phase_unavailable", message: "app.on kommt in Phase 3" }),
      expect.objectContaining({ code: "code_duplicate_on", line: 3 }),
    ]),
  });
});

test.each(["get", "post", "put", "delete", "all", "nav", "webhook", "on", "fetch"])("reports Phase 2/3 for app.%s", async (method) => {
  const result = await check(`import { app as application } from "@sdk"; application.${method}("/", () => {});`);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_phase_unavailable" })]),
  });
});

test.each([
  'import { sql } from "@k2b/cloud";',
  'import { sql } from "bun";',
  'export * from "node:fs";',
  "await import(" + '"bun");',
  '/// <reference path="/etc/passwd" />\nexport {};',
  'import { __codeSdk } from "@sdk";',
  'import * as sdk from "@sdk";',
  'type T = import("bun").SQL;',
  'import { owner } from "@sdk"; const create = owner.item.create; create({title: "x", idempotencyKey:"k"});',
  'import { owner } from "@sdk"; owner.item.create.call(null, {title: "x", idempotencyKey:"k"});',
  'import { owner } from "@sdk"; const h: any = owner; h.item.create({});',
  '// @ts-nocheck\nimport { owner } from "@sdk";',
])("rejects forbidden import or hidden call: %s", async (source) => {
  const result = await check(source);
  expect(result).toMatchObject({ ok: false });
  if (!result.ok) expect(result.diagnostics.some((d) => d.code.startsWith("code_"))).toBe(true);
});

test("tsgo rejects missing retry keys and ordinary type errors", async () => {
  const result = await check(schedule('await owner.item.create({ title: "missing key" });\nconst wrong: number = "text";'));
  expect(result).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "TS2322" })]) });
});

test("type bombs fail within the shared time/memory budget and never hang", async () => {
  const result = await check(schedule('type Bomb<T> = T extends string ? Bomb<T> : never;\ntype Explode = Bomb<"x">;'));
  expect(result).toMatchObject({ ok: false });
  if (!result.ok)
    expect(result.diagnostics.some((d) => ["TS2589", "code_check_time_limit", "code_check_memory_limit"].includes(d.code))).toBe(true);
});

test.each([
  ["sourceBytes", "code_source_limit"],
  ["bundleBytes", "code_bundle_limit"],
  ["checkMs", "code_check_time_limit"],
  ["memoryBytes", "code_check_memory_limit"],
  ["outputBytes", "code_check_output_limit"],
  ["requestBytes", "code_request_limit"],
] as const)("enforces budget %s", async (limit, code) => {
  const result = await check(schedule("await owner.stock.list({});"), { limits: { ...CODE_CHECK_LIMITS, [limit]: 1 } });
  expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code })] });
});

test("cancellation has a visible result", async () => {
  const cancelled = await checkCode({ ...base, entry: "code.ts", files: { "code.ts": schedule("") } }, host, AbortSignal.abort());
  expect(cancelled).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "code_check_cancelled" })] });
});

test("cancels and reaps an in-flight checker child", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    const result = await checkCode({ ...base, entry: "code.ts", files: { "code.ts": schedule("") } }, host, controller.signal);
    expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "code_check_cancelled" })] });
  } finally {
    clearTimeout(timer);
  }
});

test("checker children inherit neither secrets nor an IP network", async () => {
  await writeFile(
    join(directory, "probe.ts"),
    `console.log(JSON.stringify({ secret: process.env.C16_TEST_SECRET, network: await fetch("http://127.0.0.1:9").then(() => "open", () => "denied") }));`,
  );
  const child = Bun.spawn([host.isolate, host.bun, "--no-env-file", join(directory, "probe.ts")], {
    env: { C16_TEST_SECRET: "fictional" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ network: "denied" });
});

test("HTTP and secret placeholders compile and mark internet use without granting a capability target", async () => {
  const result = await check(
    'import { app, http, secrets } from "@sdk";\napp.schedule("0 8 * * 1", async () => { await http.fetch("https://api.example/v1", { headers: { authorization: "Bearer " + secrets.API } }); });\nexport default app;',
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(result.manifest.internet).toBe(true);
    expect(result.manifest.permissions).toEqual([]);
  }
});
