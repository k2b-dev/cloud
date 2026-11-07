import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chatCapabilities } from "../../../chat/src/capabilities";
import { aiDecisionQuery } from "../../../core/src/ai-decision-capability";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import codeCli from "../../../core/src/cli/code";
import {
  CODE_INITIAL_SOURCE,
  CODE_PROJECT_TSCONFIG,
  codeAuthoringContracts,
  codeInitialFiles,
} from "../../../core/src/code/authoring-contracts";
import { readCodeCheckLimits } from "../../../core/src/code/runner-jobs";
import { CODE_SETTINGS, codeSettings } from "../../../core/src/code/settings";
import { capabilityHash } from "../_internal/capability-schemas";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CloudCliContext } from "../cli";
import { type CodeCheckHost, checkCode } from "./checker";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, CodeVersionManifestSchema } from "./checker-contract";
import { generateCodeSdk } from "./generator";
import { validateCodePage } from "./page-contract";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkInvocation } from "./types";

let directory: string;
let host: Extract<CodeCheckHost, { bun: string }>;
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
}, 60_000);
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

test("the unchanged init template passes the real checker with default Core job limits", async () => {
  const settings = spyOn(codeSettings, "get").mockImplementation(async (key) => CODE_SETTINGS[key].default);
  try {
    const limits = await readCodeCheckLimits();
    // init without an owner creates personal Code. Both SDK pull and check use
    // createCodeCheckRequest's personal SDK, including its generated app typings.
    const initSdk = generateCodeSdk([], { mode: "personal" });
    expect(await check(CODE_INITIAL_SOURCE, { sdk: initSdk, limits })).toMatchObject({
      ok: true,
      diagnostics: [],
      manifest: {
        entrypoints: [{ kind: "schedule", entrypoint: "monday", cron: "0 8 * * 1", file: "code.ts", line: 3 }],
      },
    });
  } finally {
    settings.mockRestore();
  }
});

test("cld code init's TSX page passes cld code check and its generated editor tsconfig", async () => {
  const owner = { kind: "resource" as const, ref: { type: "work-shop.workshop", id: "owner-shop" } };
  const template = codeInitialFiles(owner);
  const config = { version: 1, codeId: "c_fixture", title: "Overview", owner, entry: template.entry, baseVersionId: null };
  const root = join(directory, "init-tsx");
  const project = join(root, "work-shop", "owner-shop");
  const outputs: unknown[] = [];
  const commands: string[] = [];
  let bundle = "";
  const context: CloudCliContext = {
    args: ["init"],
    flags: { title: "Overview", "owner-type": owner.ref.type, "owner-id": owner.ref.id, out: root },
    options: { profile: "fixture", server: "https://cloud.test", token: "fixture", output: "json", locale: "en" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      commands.push(path);
      if (path.endsWith("/init")) return Response.json({ version: 1, config, files: template.files });
      if (path.endsWith("/sdk"))
        return Response.json({
          version: 1,
          files: {
            "sdk/sdk.d.ts": sdk.declarations,
            "sdk/sdk.js": sdk.runtime,
            "tsconfig.json": JSON.stringify(CODE_PROJECT_TSCONFIG),
          },
        });
      expect(path).toBe("/api/code/authoring/check");
      const input = codeAuthoringContracts.check.input.parse(JSON.parse(String(init?.body)));
      expect(input).toEqual({ codeId: config.codeId, ...template });
      const result = await checkCode({ ...base, entry: input.entry, files: input.files }, host);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(result.manifest.entrypoints).toMatchObject([
        { kind: "route", route: { method: "GET", path: "/", public: false } },
        { kind: "route", route: { method: "POST", path: "/items", public: false } },
      ]);
      bundle = result.bundle;
      return Response.json({ version: 1, result, manifest: { ...result.manifest, entry: input.entry, policyRows: [] }, permissions: [] });
    },
    readJson: async (response) => response.json(),
    print: (value) => {
      outputs.push(value);
    },
    write: async (value) => {
      outputs.push(value);
    },
    error: (message) => {
      throw new Error(message);
    },
    json: (value) => {
      outputs.push(value);
    },
    jsonLine: (value) => {
      outputs.push(value);
    },
    table: () => {
      throw new Error("unused");
    },
  };
  expect(template.entry).toBe("code.tsx");
  expect(await codeCli.run(context)).toBe(0);
  context.args = ["sdk", "pull", project];
  context.flags = {};
  expect(await codeCli.run(context)).toBe(0);
  context.args = ["check", project];
  expect(await codeCli.run(context)).toBe(0);
  expect(commands).toEqual(["/api/code/authoring/init", "/api/code/authoring/sdk", "/api/code/authoring/check"]);
  expect(outputs.at(-1)).toMatchObject({ result: { ok: true } });
  const types = Bun.spawn([host.compiler, "--checkers", "1", "--project", join(project, "tsconfig.json"), "--pretty", "false"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([types.exited, new Response(types.stdout).text(), new Response(types.stderr).text()]);
  expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
  // The starting page is one Core draws: key figures, a section with a chart, a form and a table.
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
  const response = await module["route:GET:/"](
    { method: "GET", path: "/", query: "", params: {}, contentType: "text/plain", body: "", user: null },
    { call: async () => null },
  );
  const tree = validateCodePage(response.tree, config.codeId);
  expect(tree.children.map((node) => node.kind)).toEqual(["Stats", "Section"]);
  const section = tree.children[1];
  expect(section?.kind === "Section" && section.children.map((node) => node.kind)).toEqual(["Chart", "Form", "Table"]);
}, 60_000);

test("core.ai.decide is AI in the generated SDK and mail triage checks category before urgency", async () => {
  const manifests = [compileCapabilityManifest("core", { protocolVersion: 2, queries: { "ai.decide": aiDecisionQuery } })];
  const sdk = generateCodeSdk(manifests, { mode: "code_run" });
  const docs = await Bun.file(resolve(import.meta.dir, "../../../../docs-site/docs/en/platform/code-sdk.md")).text();
  const skill = await Bun.file(resolve(import.meta.dir, "../../../assistant/src/skills/code-authoring/SKILL.md")).text();
  const snippet = (text: string) => text.split("<!-- ai1-mail-triage -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const source = snippet(docs);
  expect(snippet(skill)).toBe(source);
  const checked = await check(source, {
    sdk,
    aiOperations: sdk.manifest.operations.filter((op) => op.capability.startsWith("core.ai.")).map((op) => op.capability),
  });
  expect(checked).toMatchObject({ ok: true });
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.manifest.ai).toBe(true);
  expect(checked.permissions).toMatchObject([{ operation: "core.ai.decide", target: null }]);
  const response = (choice: string) => ({
    answers: {
      category: {
        type: "choice",
        choice,
        confidence: 0.99,
        probabilities: { support: choice === "support" ? 0.99 : 0.01, spam: choice === "spam" ? 0.99 : 0.01 },
      },
      urgent: { type: "noul", probability: 0.99, value: true },
    },
  });
  for (const category of ["spam", "support"]) {
    // Each runner execution gets its own module and binds the bridge only once.
    const path = join(directory, `triage-${category}.mjs`);
    await writeFile(path, checked.bundle);
    const triage = await import(path);
    const calls: string[] = [];
    expect(
      await triage.run(null, {
        call: async (operation: string) => {
          calls.push(operation);
          return response(category);
        },
      }),
    ).toBe(category === "support");
    expect(calls).toEqual(["core.ai.decide"]);
  }
  // Lasting Code can reuse the exact example as a helper in a void-returning schedule.
  const lasting = await check("", {
    sdk: generateCodeSdk(manifests, { mode: "personal" }),
    aiOperations: ["core.ai.decide"],
    files: {
      "code.ts": `import { app } from "@sdk";
import triage from "./triage";
app.schedule("0 8 * * 1", async () => { await triage(); }, { name: "triage" });
export default app;`,
      "triage.ts": source,
    },
  });
  expect(lasting).toMatchObject({ ok: true, manifest: { ai: true } });
  if (!lasting.ok) throw new Error(JSON.stringify(lasting.diagnostics));
  expect(lasting.permissions).toMatchObject([{ operation: "core.ai.decide", target: null }]);
});

test("text and JSON generation SDK example passes the real checker as AI for one-off and lasting Code", async () => {
  const manifests = [compileCapabilityManifest("core", { protocolVersion: 2, queries: { "ai.generate": aiGenerationQuery } })];
  const docs = await Bun.file(resolve(import.meta.dir, "../../../../docs-site/docs/en/platform/code-sdk.md")).text();
  const source = docs.split("<!-- gate-1a-generation -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const aiOperations = ["core.ai.generate"];
  const checked = await check(source, { sdk: generateCodeSdk(manifests, { mode: "code_run" }), aiOperations });
  expect(checked).toMatchObject({ ok: true, manifest: { ai: true } });
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.permissions.map((permission) => permission.operation)).toEqual(["core.ai.generate", "core.ai.generate"]);
  const lasting = await check("", {
    sdk: generateCodeSdk(manifests, { mode: "personal" }),
    aiOperations,
    files: {
      "code.ts":
        'import { app } from "@sdk"; import summarize from "./summary"; app.schedule("0 8 * * 1", async () => { await summarize(); }, { name: "summary" }); export default app;',
      "summary.ts": source,
    },
  });
  expect(lasting).toMatchObject({ ok: true, manifest: { ai: true } });
  if (!lasting.ok) throw new Error(JSON.stringify(lasting.diagnostics));
  expect(lasting.permissions.map((permission) => permission.operation)).toEqual(["core.ai.generate", "core.ai.generate"]);
}, 30_000);

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
      entrypoints: ["weekly"],
      status: "existing",
    },
    {
      operation: "work-shop.item.move",
      target: { type: "work-shop.workshop", id: "owner-shop" },
      file: "code.ts",
      line: 6,
      entrypoints: ["weekly"],
      status: "new",
    },
    {
      operation: "work-shop.item.move",
      target: { type: "work-shop.workshop", id: "imported-shop" },
      file: "code.ts",
      line: 6,
      entrypoints: ["weekly"],
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

test("each permission names the schedules whose handler makes the call, and never guesses", async () => {
  const result = await check("", {
    files: {
      "code.ts": [
        `import { app, owner } from "@sdk";`,
        `import { nightly } from "./jobs";`,
        `const helper = async () => { await owner.item.create({ title: "Helper", idempotencyKey: "helper" }); };`,
        `const shared = async () => { await owner.item.move({ itemId: "one", destination: owner }); };`,
        `let swappable = async () => { await owner.item.create({ title: "Swappable", idempotencyKey: "swap" }); };`,
        `app.schedule("0 8 * * 1", async () => { await owner.item.create({ title: "Weekly", idempotencyKey: "weekly" }); await helper(); }, { name: "weekly" });`,
        `app.schedule("0 9 * * 1", nightly, { name: "nightly" });`,
        `app.schedule("0 10 * * 1", shared, { name: "morning" });`,
        `app.schedule("0 11 * * 1", shared, { name: "evening" });`,
        `app.schedule("0 12 * * 1", swappable, { name: "noon" });`,
        `app.schedule("0 14 * * 1", async () => { await Promise.all(["a"].map((key) => owner.item.create({ title: key, idempotencyKey: "nested" }))); }, { name: "nested" });`,
        `export default app;`,
      ].join("\n"),
      "jobs.ts": `import { owner } from "@sdk";\nexport async function nightly() {\n  await owner.item.create({ title: "Nightly", idempotencyKey: "nightly" });\n}`,
    },
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  const placed = result.manifest.permissions.map((p) => [p.file, p.line, p.entrypoints ?? null]);
  expect(placed).toEqual([
    ["jobs.ts", 3, ["nightly"]],
    // A helper the handler calls, and a let binding that could change, are not attributed.
    ["code.ts", 3, null],
    // The move and its destination ref are two permissions from one call; both belong to the shared handler.
    ["code.ts", 4, ["evening", "morning"]],
    ["code.ts", 4, ["evening", "morning"]],
    ["code.ts", 5, null],
    ["code.ts", 6, ["weekly"]],
    // A nested callback runs when its caller decides, not because the handler runs.
    ["code.ts", 11, null],
  ]);
  expect(CodeVersionManifestSchema.parse(result.manifest)).toEqual(result.manifest);
});

test("a schedule's named function declaration cannot be swapped for another body", async () => {
  // Attribution relies on this: a declaration always runs its own body.
  const result = await check(
    `import { app, owner } from "@sdk";\nfunction weekly() {}\nweekly = async () => {};\napp.schedule("0 8 * * 1", weekly, { name: "weekly" });\nexport default app;`,
  );
  expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "TS2630", line: 3 })] });
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

test("accepts dynamic resource targets and records their type as non-binding review evidence", async () => {
  const result = await check(
    schedule('const id: string = String("dynamic");\nawait work_shop.workshop(id).item.create({ title: "x", idempotencyKey: "k" });'),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.permissions).toContainEqual(expect.objectContaining({ target: { type: "work-shop.workshop", id: null } }));
});

test.each([
  ["outside.change", "code_code_false"],
  ["stock.export", "code_stream"],
])("rejects omitted operation %s", async (method, code) => {
  const result = await check(schedule(`await owner.${method}({});`));
  expect(result).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) });
});

test("a checked resource event bundle receives the reference envelope as its one run input", async () => {
  const manifest = sdkFixture();
  manifest.events![0]!.place = "workshop";
  const result = await check(
    'import {app,owner} from "@sdk"; app.get("/health", c => c.text("Ready")); app.on("work-shop.changed", async event => {await owner.stock.list({cursor:event.subject.id});}); app.schedule({at:"2030-01-02T09:00:00Z",timeZone:"UTC"}, async () => {await owner.stock.list({cursor:"once"});}); export default app;',
    {
      sdk: generateCodeSdk([manifest], {
        mode: "resource",
        owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } },
      }),
    },
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.manifest.entrypoints).toMatchObject([
    { kind: "route", entrypoint: "route:GET:/health", route: { method: "GET", path: "/health", public: false } },
    {
      kind: "event",
      entrypoint: "event:work-shop.changed@1",
      event: { type: "work-shop.changed", version: 1, place: { type: "work-shop.workshop", id: "owner-shop" } },
    },
    { kind: "schedule", entrypoint: "schedule:0", cron: null, at: "2030-01-02T09:00:00Z", timeZone: "UTC" },
  ]);
  const file = join(directory, "event-bundle.mjs");
  await writeFile(file, result.bundle);
  const module = await import(file);
  const input = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "work-shop.changed",
    version: 1,
    source: "work-shop",
    time: "2026-11-06T12:00:00Z",
    subject: { type: "work-shop.workshop", id: "item-a" },
    place: { type: "work-shop.workshop", id: "owner-shop" },
    data: { title: "fixture" },
  };
  // Each runner starts a fresh module with its own one-use bridge.
  const routeModule = await import(`${file}?route`);
  expect(
    await routeModule["route:GET:/health"](
      { method: "GET", path: "/health", query: "", contentType: "", params: {}, user: { id: "visitor", groups: [] } },
      {
        call: async () => {
          throw new Error("unexpected_call");
        },
      },
    ),
  ).toEqual({ kind: "text", status: 200, body: "Ready" });
  const calls: unknown[] = [];
  await module["event:work-shop.changed@1"](input, {
    call: async (operation: string, value: unknown) => {
      calls.push({ operation, value });
      return { rows: [], next: null };
    },
  });
  expect(calls).toMatchObject([{ operation: "work-shop.stock.list", value: { call: { input: { cursor: "item-a" } } } }]);
  const onceModule = await import(`${file}?once`);
  const onceCalls: unknown[] = [];
  await onceModule["schedule:0"](null, {
    call: async (operation: string, value: unknown) => {
      onceCalls.push({ operation, value });
      return { rows: [], next: null };
    },
  });
  expect(onceCalls).toMatchObject([{ operation: "work-shop.stock.list", value: { call: { input: { cursor: "once" } } } }]);
}, 30_000);

test("rejects duplicate event/place subscriptions", async () => {
  const manifest = sdkFixture();
  manifest.events![0]!.place = "workshop";
  const result = await check(
    `import { app, owner, work_shop } from "@sdk";\napp.on("work-shop.changed", () => {});\napp.on(owner, "work-shop.changed", () => {});`,
    {
      sdk: generateCodeSdk([manifest], {
        mode: "resource",
        owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } },
      }),
    },
  );
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_duplicate_on", line: 3 })]),
  });
});

test.each(["nav", "webhook", "fetch"])("reports Phase 2/3 for app.%s", async (method) => {
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
    expect(result.manifest.internet).toEqual(["https://api.example"]);
    expect(result.manifest.permissions).toEqual([]);
  }
});

test("HTTP methods cannot be detached to hide their internet use from checking", async () => {
  const result = await check(
    'import { app, http } from "@sdk"; const send = http.fetch; app.schedule("0 8 * * 1", async () => { await send("https://api.example/v1"); }); export default app;',
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "code_detached_sdk_method")).toBe(true);
});

test("destructured HTTP methods retain internet evidence through their SDK signature", async () => {
  const result = await check(
    'import { app, http } from "@sdk"; const { fetch: send } = http; app.schedule("0 8 * * 1", async () => { await send("https://api.example/v1"); }); export default app;',
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.manifest.internet).toEqual(["https://api.example"]);
});

test("a titled schedule runs by its stable identifier and a title change changes version evidence", async () => {
  const source = schedule("return;").replace('{ name: "weekly" }', '{ name: "weekly", title: "  Weekly report  " }');
  const result = await check(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.manifest.entrypoints[0]).toMatchObject({ entrypoint: "weekly", title: "Weekly report" });
  const path = join(directory, "titled.mjs");
  await writeFile(path, result.bundle);
  const module = await import(path);
  expect(await module.weekly(null, { call: async () => null })).toBeUndefined();
  const changed = await check(source.replace("Weekly report", "Weekly summary"));
  expect(changed.ok).toBe(true);
  if (!changed.ok) return;
  expect(changed.manifest.entrypoints[0]?.title).toBe("Weekly summary");
  expect(changed.manifest.hashes.source).not.toBe(result.manifest.hashes.source);
  expect(changed.manifest.hashes.bundle).not.toBe(result.manifest.hashes.bundle);
});

test("one-time schedules coexist with routes through the real checker and bundle registration fence", async () => {
  const result = await check(
    `import { app } from "@sdk";
app.schedule({ at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" }, async () => {}, { name: "reminder" });
app.get("/reminder", c => c.text("Scheduled"));
export default app;`,
    { limits: { ...CODE_CHECK_LIMITS, checkMs: 60_000 } },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.ok).toBeTrue();
  expect(result.manifest.entrypoints[0]).toMatchObject({ cron: null, at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" });
  expect(result.manifest.entrypoints[1]).toMatchObject({ kind: "route", route: { method: "GET", path: "/reminder", public: false } });
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  await loaded.reminder(null, {
    async call() {
      throw new Error("No call expected");
    },
  });
}, 90_000);

test("checked route bundles execute the selected request handler without a web framework", async () => {
  const result = await check(`import { app } from "@sdk";
app.get("/hello/:name", c => c.json({ person: c.user?.id ?? null, name: c.req.param("name") }));
app.post("/save", c => c.redirect("/hello/saved"));`);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.manifest.entrypoints[0]).toMatchObject({ kind: "route", route: { method: "GET", path: "/hello/:name", public: false } });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  expect(
    await module["route:GET:/hello/:name"](
      {
        method: "GET",
        path: "/hello/Valentin",
        query: "",
        params: { name: "Valentin" },
        contentType: "text/plain",
        body: "",
        user: { id: "visitor", groups: [] },
      },
      { call: async () => null },
    ),
  ).toEqual({ kind: "json", status: 200, body: JSON.stringify({ person: "visitor", name: "Valentin" }) });
  expect(result.bundle).not.toContain("hono");
}, 30_000);

test("TSX and object pages produce identical validated trees without a framework bundle", async () => {
  const result = await checkCode(
    {
      ...base,
      entry: "code.tsx",
      limits: { ...CODE_CHECK_LIMITS, checkMs: 30000 },
      files: {
        "code.tsx": `import { app, jsx, Page, Section, Text, Form, Chart } from "@sdk";
app.get("/", c => c.page(<Page title="Items"><Section title="Today"><Text>Hello {"there"}</Text><Chart.Bar title="Count" data={[{label:"One",value:2}]} /><Form title="Find" action="/find" fields={[{type:"scan",name:"barcode",label:"Barcode"}]} submit="Find" /></Section></Page>));
app.get("/object", c => c.page({
  version: 1, kind: "Page", title: "Items", children: [{ kind: "Section", title: "Today", children: [
    { kind: "Text", text: "Hello there" },
    { kind: "Chart", description: { kind: "bar", title: "Count", data: [{ label: "One", value: 2 }] } },
    { kind: "Form", title: "Find", action: "/find", fields: [{ type: "scan", name: "barcode", label: "Barcode" }], submit: "Find" },
  ] }],
}));`,
      },
    },
    host,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  const response = await module["route:GET:/"](
    { method: "GET", path: "/", query: "", params: {}, contentType: "text/plain", body: "", user: null },
    { call: async () => null },
  );
  expect(response).toMatchObject({
    kind: "page",
    tree: {
      version: 1,
      kind: "Page",
      title: "Items",
      children: [
        { kind: "Section", title: "Today", children: [{ kind: "Text", text: "Hello there" }, { kind: "Chart" }, { kind: "Form" }] },
      ],
    },
  });
  const objectPath = join(directory, "object-page.mjs");
  await writeFile(objectPath, result.bundle);
  const objectModule = await import(objectPath);
  const objectResponse = await objectModule["route:GET:/object"](
    { method: "GET", path: "/object", query: "", params: {}, contentType: "text/plain", body: "", user: null },
    { call: async () => null },
  );
  expect(response).toEqual(objectResponse);
  expect(validateCodePage(response.tree, "c_fixture")).toEqual(validateCodePage(objectResponse.tree, "c_fixture"));
  for (const runtime of ["solid-js", "hono", "react/jsx-runtime"]) expect(result.bundle).not.toContain(runtime);
}, 30000);
test("TSX refuses intrinsic HTML and handler props", async () => {
  // A chart is either drawn from a description or empty with a reason; a bare title is neither.
  for (const child of ["<div>HTML</div>", "<Text onClick={() => {}}>Handler</Text>", '<Chart title="Orders" />']) {
    const result = await checkCode(
      {
        ...base,
        entry: "code.tsx",
        limits: { ...CODE_CHECK_LIMITS, checkMs: 30000 },
        files: {
          "code.tsx": `import { app, jsx, Page, Text, Chart } from "@sdk"; app.get("/",c=>c.page(<Page title="Bad">${child}</Page>));`,
        },
      },
      host,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code.startsWith("TS"))).toBe(true);
  }
}, 60000);

test("personal scheduled Code generates a summary and posts it into the owner's selected Chat", async () => {
  const sdk = generateCodeSdk(
    [
      compileCapabilityManifest("core", { protocolVersion: 2, queries: { "ai.generate": aiGenerationQuery } }),
      compileCapabilityManifest("chat", chatCapabilities),
    ],
    { mode: "personal" },
  );
  const source = `import { app, core, chat } from "@sdk";
app.schedule({ at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" }, async () => {
  const result = await core.app().ai.generate({ task: "daily.summary", prompt: "Summarize the supplied notes.", input: { notes: "Delivery received." }, output: { type: "text", maxChars: 1200 } });
  if (typeof result.output !== "object" || result.output === null || !("text" in result.output) || typeof result.output.text !== "string") throw new Error("Unexpected summary output");
  await chat.app().message.post({ conversation: "Chat01", body: result.output.text, idempotencyKey: "summary-2026-12-01" });
}, { name: "reminder", title: "Send summary" });
export default app;`;
  const checked = await check(source, { sdk, aiOperations: ["core.ai.generate"], limits: { ...CODE_CHECK_LIMITS, checkMs: 60_000 } });
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.manifest.ai).toBeTrue();
  expect(checked.manifest.permissions.map((entry) => entry.operation).sort()).toEqual(["chat.message.post", "core.ai.generate"]);
  const calls: Array<{ operation: string; invocation: CodeSdkInvocation }> = [];
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(checked.bundle).toString("base64")}`);
  await loaded.reminder(null, {
    async call(operation: string, invocation: CodeSdkInvocation) {
      calls.push({ operation, invocation });
      if (operation === "core.ai.generate") return { output: { text: "Summary: delivery received." } };
      if (operation === "chat.message.post") return { id: "Msg001", conversation: "Chat01", createdAt: "2026-12-01T08:15:30.000Z" };
      throw new Error("Unexpected operation");
    },
  });
  expect(calls.map((entry) => entry.operation)).toEqual(["core.ai.generate", "chat.message.post"]);
  expect(calls[1]!.invocation).toEqual({
    call: {
      capability: "chat.message.post",
      target: null,
      refs: {},
      input: { conversation: "Chat01", body: "Summary: delivery received." },
    },
    metadata: { idempotencyKey: "summary-2026-12-01" },
  });
}, 90_000);
