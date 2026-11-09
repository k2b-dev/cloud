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
import { mailCapabilities } from "../../../mail/src/capabilities";
import { capabilityHash } from "../_internal/capability-schemas";
import { compileCapabilityManifest } from "../capabilities/testing";
import type { CloudCliContext } from "../cli";
import { type CodeCheckHost, checkCode } from "./checker";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, CodeVersionManifestSchema } from "./checker-contract";
import { fileImportManifest } from "./file-ref.test-fixture";
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
  `import { app, owner, work_shop } from "@sdk";\napp.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => {\n${body}\n});\nexport default app;`;

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
        { kind: "route", route: { method: "POST", path: "/orders", public: false } },
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
  // Both routes deny access until an author fills the explicit group allowlist.
  const request = {
    method: "GET",
    path: "/",
    query: "",
    params: {},
    contentType: "text/plain",
    body: "",
    user: { id: "visitor", username: "visitor", groupIds: [], groupNames: [], kind: "user", name: "Visitor" },
  };
  for (const [entrypoint, method, path] of [
    ["route:GET:/", "GET", "/"],
    ["route:POST:/orders", "POST", "/orders"],
  ]) {
    const modulePath = join(directory, `init-${method}.mjs`);
    await writeFile(modulePath, bundle);
    const module = await import(modulePath);
    const response = await module[entrypoint!](
      { ...request, method, path },
      {
        call: async () => {
          throw new Error("denied handlers must not call capabilities");
        },
      },
    );
    expect(response).toEqual({ kind: "json", status: 403, body: JSON.stringify({ error: "forbidden" }) });
  }
}, 60_000);

test("core.ai.decide is AI in the generated SDK and mail triage checks category before urgency", async () => {
  const manifests = [compileCapabilityManifest("core", { protocolVersion: 2, queries: { "ai.decide": aiDecisionQuery } })];
  const sdk = generateCodeSdk(manifests, { mode: "code_run" });
  const docs = await Bun.file(resolve(import.meta.dir, "../../../../docs-site/docs/en/platform/code-sdk.md")).text();
  // The Code authoring skill's own examples are checked by its examples test in packages/assistant.
  const snippet = (text: string) => text.split("<!-- ai1-mail-triage -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const source = snippet(docs);
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
          return { data: response(category) };
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
app.schedule({ cron: "0 8 * * 1", name: "triage" }, async () => { await triage(); });
export default app;`,
      "triage.ts": source,
    },
  });
  expect(lasting).toMatchObject({ ok: true, manifest: { ai: true } });
  if (!lasting.ok) throw new Error(JSON.stringify(lasting.diagnostics));
  expect(lasting.permissions).toMatchObject([{ operation: "core.ai.decide", target: null }]);
});

test("the documented query loop checks against a third-party SDK with a bounded page budget", async () => {
  const docs = await Bun.file(resolve(import.meta.dir, "../../../../docs-site/docs/en/platform/code-sdk.md")).text();
  const source = docs.split("<!-- code-query-pagination -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const checked = await check(source, { sdk: generateCodeSdk([sdkFixture()], { mode: "code_run" }) });
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.permissions.map((permission) => permission.operation)).toEqual(["work-shop.stock.list"]);
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
        'import { app } from "@sdk"; import summarize from "./summary"; app.schedule({ cron: "0 8 * * 1", name: "summary" }, async () => { await summarize(); }); export default app;',
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
      "code.ts": `import { app, owner, work_shop } from "@sdk";\nimport { target } from "./ids";\nconst h = work_shop.workshop(target);\napp.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => {\nawait h.item.create({ title: "Hello", idempotencyKey: "weekly:fixed" });\nawait owner.item.move({ itemId: "item-one", destination: h });\n});\nexport default app;`,
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
        `app.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => { await owner.item.create({ title: "Weekly", idempotencyKey: "weekly" }); await helper(); });`,
        `app.schedule({ cron: "0 9 * * 1", name: "nightly" }, nightly);`,
        `app.schedule({ cron: "0 10 * * 1", name: "morning" }, shared);`,
        `app.schedule({ cron: "0 11 * * 1", name: "evening" }, shared);`,
        `app.schedule({ cron: "0 12 * * 1", name: "noon" }, swappable);`,
        `app.schedule({ cron: "0 14 * * 1", name: "nested" }, async () => { await Promise.all(["a"].map((key) => owner.item.create({ title: key, idempotencyKey: "nested" }))); });`,
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
    `import { app, owner } from "@sdk";\nfunction weekly() {}\nweekly = async () => {};\napp.schedule({ cron: "0 8 * * 1", name: "weekly" }, weekly);\nexport default app;`,
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
      "nested/code.ts": 'import "./first"; import { app } from "@sdk"; app.schedule({ cron: "0 9 * * *" }, () => {});',
      "nested/first.ts": 'import { app } from "@sdk"; app.schedule({ cron: "0 8 * * *" }, () => {});',
      "unused.ts": 'import { app } from "@sdk"; app.schedule({ cron: "0 10 * * *" }, () => {});',
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
      "code.ts": 'import "./cycle"; import { app } from "@sdk"; app.schedule({ cron: "0 8 * * *", name: "cycle"}, () => {});',
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
  const result = await check(`import {app} from "@sdk"; app.schedule({ cron: ${JSON.stringify(cron)} }, () => {});`);
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
      "a.ts": 'import {app} from "@sdk"; app.schedule({ cron: "0 8 * * *" }, () => {});',
      "b.ts": 'import {app} from "@sdk"; export interface T {} app.schedule({ cron: "0 9 * * *" }, () => {});',
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
      "a.ts": 'import {app} from "@sdk"; app.schedule({ cron: "0 8 * * *" }, () => {});',
      "b.ts": 'import {app} from "@sdk"; export const x = 1; app.schedule({ cron: "0 9 * * *" }, () => {});',
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
        "b.ts": 'import {app} from "@sdk"; export const x = 1; export interface X {} app.schedule({ cron: "0 9 * * *" }, () => {});',
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

test.each([["outside.change", "code_code_false"]])("rejects omitted operation %s", async (method, code) => {
  const result = await check(schedule(`await owner.${method}({});`));
  expect(result).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) });
});

test("checked resource events and zoned schedules execute through the bundle registration fence", async () => {
  const manifest = sdkFixture();
  manifest.events![0]!.place = "workshop";
  const result = await check(
    `import { app, owner } from "@sdk";
app.get("/health", c => c.text("Ready"));
app.on("work-shop.changed", async event => { await owner.stock.list({ cursor: event.subject.id }); });
app.schedule({ at: "2030-01-02T09:00:00Z", timeZone: "UTC" }, async () => { await owner.stock.list({ cursor: "once" }); });
app.schedule({ cron: "0 9 * * *", timeZone: "Europe/Berlin" }, async () => { await owner.stock.list({ cursor: "daily" }); });
export default app;`,
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
    { kind: "schedule", entrypoint: "schedule:1", cron: "0 9 * * *", timeZone: "Europe/Berlin" },
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
      {
        method: "GET",
        path: "/health",
        query: "",
        contentType: "",
        params: {},
        user: { id: "visitor", username: "visitor", groupIds: [], groupNames: [], kind: "user", name: "Visitor" },
      },
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
  const dailyModule = await import(`${file}?daily`);
  const dailyCalls: unknown[] = [];
  await dailyModule["schedule:1"](null, {
    call: async (operation: string, value: unknown) => {
      dailyCalls.push({ operation, value });
      return { rows: [], next: null };
    },
  });
  expect(dailyCalls).toMatchObject([{ operation: "work-shop.stock.list", value: { call: { input: { cursor: "daily" } } } }]);
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

test.each(["nav", "webhook", "fetch"])("rejects removed app.%s", async (method) => {
  const result = await check(`import { app as application } from "@sdk"; application.${method}("/", () => {});`);
  expect(result).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "code_removed_api" })]),
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
    'import { app, http, secrets } from "@sdk";\napp.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => { await http.fetch("https://api.example/v1", { headers: { authorization: "Bearer " + secrets.API } }); });\nexport default app;',
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(result.manifest.internet).toEqual(["https://api.example"]);
    expect(result.manifest.permissions).toEqual([]);
  }
});

test("HTTP methods cannot be detached to hide their internet use from checking", async () => {
  const result = await check(
    'import { app, http } from "@sdk"; const send = http.fetch; app.schedule({ cron: "0 8 * * 1" }, async () => { await send("https://api.example/v1"); }); export default app;',
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "code_detached_sdk_method")).toBe(true);
});

test("destructured HTTP methods retain internet evidence through their SDK signature", async () => {
  const result = await check(
    'import { app, http } from "@sdk"; const { fetch: send } = http; app.schedule({ cron: "0 8 * * 1" }, async () => { await send("https://api.example/v1"); }); export default app;',
  );
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.manifest.internet).toEqual(["https://api.example"]);
});

test("a titled schedule runs by its stable identifier and a title change changes version evidence", async () => {
  const source = schedule("return;").replace('name: "weekly"', 'name: "weekly", title: "  Weekly report  "');
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
app.schedule({ at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin", name: "reminder" }, async () => {});
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
app.get("/hello/:name", c => c.json({ person: c.user?.id ?? null, kind: c.user?.kind, username: c.user?.username, displayName: c.user?.name, name: c.req.param("name") }));
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
        user: { id: "visitor", username: "visitor", groupIds: [], groupNames: [], kind: "guest", name: "Visitor" },
      },
      { call: async () => null },
    ),
  ).toEqual({
    kind: "json",
    status: 200,
    body: JSON.stringify({ person: "visitor", kind: "guest", username: "visitor", displayName: "Visitor", name: "Valentin" }),
  });
  expect(result.bundle).not.toContain("hono");
}, 30_000);

test("TSX building blocks compose the checked page tree without a framework bundle", async () => {
  const result = await checkCode(
    {
      ...base,
      entry: "code.tsx",
      limits: { ...CODE_CHECK_LIMITS, checkMs: 30000 },
      files: {
        "code.tsx": `import { app, jsx, Page, Section, Text, Stats, Stat, Table, Column, Detail, Item, Form, Field, Option, Chart } from "@sdk";
const statuses = ["open", "done"];
app.get("/", c => c.page(
  <Page title="Items">
    <Stats><Stat label="Open" value={3} delta={{ value: 0.5, better: "down" }} compare={{ label: "Yesterday", value: 2 }} /></Stats>
    <Section title="Today">
      <Text>Hello {"there"}</Text>
      <Chart.Bar width="half" title="Count" data={[{ label: "One", value: 2 }]} />
      <Chart.Empty width="half" title="Orders" empty="No order yet." />
      <Table title="Items" rows={[{ name: "One" }]}><Column key="name" label="Name" /></Table>
      <Detail title="Item"><Item label="Code" value="W-1" /></Detail>
      <Form title="Find" action="/find" submit="Find">
        <Field.Scan name="barcode" label="Barcode" required />
        <Field.Number name="count" label="Count" value={1} />
        <Field.Select name="status" label="Status" value="open">
          {statuses.map(status => <Option value={status} label={status} />)}
        </Field.Select>
        <Field.Checkbox name="urgent" label="Urgent" />
      </Form>
    </Section>
  </Page>
));`,
      },
    },
    host,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  const response = await module["route:GET:/"](
    { method: "GET", path: "/", query: "", params: {}, contentType: "text/plain", body: "", user: null },
    { call: async () => null },
  );
  // Authors compose blocks; the description below is only the transport Core checks and draws.
  expect(validateCodePage(response.tree, "c_fixture")).toEqual({
    version: 1,
    kind: "Page",
    title: "Items",
    children: [
      {
        kind: "Stats",
        items: [{ label: "Open", value: 3, delta: { value: 0.5, better: "down" }, compare: { label: "Yesterday", value: 2 } }],
      },
      {
        kind: "Section",
        title: "Today",
        children: [
          { kind: "Text", text: "Hello there" },
          { kind: "Chart", width: "half", description: { kind: "bar", title: "Count", data: [{ label: "One", value: 2 }] } },
          { kind: "Chart", width: "half", title: "Orders", empty: "No order yet." },
          { kind: "Table", title: "Items", rows: [{ name: "One" }], columns: [{ key: "name", label: "Name" }] },
          { kind: "Detail", title: "Item", items: [{ label: "Code", value: "W-1" }] },
          {
            kind: "Form",
            title: "Find",
            action: "/find",
            submit: "Find",
            fields: [
              { type: "scan", name: "barcode", label: "Barcode", required: true },
              { type: "number", name: "count", label: "Count", value: 1 },
              {
                type: "select",
                name: "status",
                label: "Status",
                value: "open",
                options: [
                  { value: "open", label: "open" },
                  { value: "done", label: "done" },
                ],
              },
              { type: "checkbox", name: "urgent", label: "Urgent" },
            ],
          },
        ],
      },
    ],
  });
  for (const runtime of ["solid-js", "hono", "react/jsx-runtime"]) expect(result.bundle).not.toContain(runtime);
}, 30000);
test("the page example in the docs checks and builds a valid page", async () => {
  const docs = await Bun.file(resolve(import.meta.dir, "../../../../docs-site/docs/en/platform/code-sdk.md")).text();
  const snippet = (text: string) => text.split("<!-- code-page-example -->")[1]!.split("```tsx\n")[1]!.split("```")[0]!.trim();
  const source = snippet(docs);
  const result = await checkCode(
    { ...base, entry: "code.tsx", limits: { ...CODE_CHECK_LIMITS, checkMs: 30000 }, files: { "code.tsx": source } },
    host,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  const response = await module["route:GET:/"](
    { method: "GET", path: "/", query: "", params: {}, contentType: "text/plain", body: "", user: null },
    { call: async () => null },
  );
  expect(validateCodePage(response.tree, "c_fixture").children.map((node) => node.kind)).toEqual(["Stats", "Section"]);
}, 30000);
test("the survey template is identical in skill and Fibel and declares a public page without the Cloud layout", async () => {
  const sources = await Promise.all(
    ["../../../../docs-site/docs/en/platform/code-sdk.md", "../../../assistant/src/skills/code-authoring/templates/survey.md"].map((path) =>
      Bun.file(resolve(import.meta.dir, path)).text(),
    ),
  );
  const snippet = (text: string) => text.split("<!-- code-survey-example -->")[1]!.split("```tsx\n")[1]!.split("```")[0]!.trim();
  expect(snippet(sources[1]!)).toBe(snippet(sources[0]!));
  expect(snippet(sources[0]!).match(/\{ public: true, layout: "plain" \}|public: true,\n\s+layout: "plain",/g)).toHaveLength(2);
});
test("the invoice template is identical in skill and Fibel, checks against the live Mail SDK and passes FileRefs", async () => {
  const sources = await Promise.all(
    [
      "../../../../docs-site/docs/en/platform/code-sdk.md",
      "../../../../docs-site/docs/en/platform/capabilities.md",
      "../../../assistant/src/skills/code-authoring/templates/mail-invoices.md",
    ].map((path) => Bun.file(resolve(import.meta.dir, path)).text()),
  );
  const snippet = (text: string) => text.split("<!-- code-file-example -->")[1]!.split("```ts\n")[1]!.split("```")[0]!.trim();
  const source = snippet(sources[0]!);
  for (const text of sources) expect(snippet(text)).toBe(source);
  const mail = compileCapabilityManifest("mail", mailCapabilities);
  const sdk = generateCodeSdk([mail, fileImportManifest()], {
    mode: "resource",
    owner: { kind: "resource", ref: { type: "mail.mailbox", id: "Mb4g00" } },
  });
  const result = await checkCode(
    { ...base, sdk, files: { "code.ts": source }, entry: "code.ts", limits: { ...CODE_CHECK_LIMITS, checkMs: 30_000 } },
    host,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const calls: CodeSdkInvocation[] = [];
  let hydrationReads = 0;
  const file = { id: "fake-file-ref", name: "invoice.pdf", mediaType: "application/pdf", size: 5_000_000 };
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
  await module["event:mail.message.received@1"](
    {
      id: "11111111-1111-4111-8111-111111111111",
      type: "mail.message.received",
      version: 1,
      source: "mail",
      time: "2026-11-07T12:00:00.000Z",
      subject: { type: "mail.message", id: "Ms4g00" },
      place: { type: "mail.mailbox", id: "Mb4g00" },
      data: { receiptId: "22222222-2222-4222-8222-222222222222" },
    },
    {
      call: async (_operation: string, input: CodeSdkInvocation) => {
        calls.push(input);
        if (input.call.capability === "mail.message.read")
          return {
            data: {
              hydrationStatus: ++hydrationReads <= 5 ? "envelope" : "complete",
              attachmentsTruncated: false,
              conversationId: "Cv4g00",
              attachments: [{ id: "At4g00", contentType: "application/pdf" }],
            },
          };
        if (input.call.capability === "mail.attachment.content.read") return file;
        if (input.call.capability === "imports.import") return { imported: true };
        if (input.call.capability === "mail.conversation.read") return { data: { collaboration: { revision: 4 } } };
        return {};
      },
    },
  );
  expect(hydrationReads).toBe(6);
  for (const call of calls.slice(0, 6)) expect(call.call.input).toEqual({ id: "Ms4g00", waitForHydration: true });
  // Five pending replies did not spend five run attempts or perform an early effect.
  expect(calls.map((input) => input.call.capability)).toEqual([
    ...Array(6).fill("mail.message.read"),
    "mail.attachment.content.read",
    "imports.import",
    "mail.conversation.read",
    "mail.conversation.tag.update",
  ]);
  expect(calls[7]).toMatchObject({
    call: { input: { file } },
    metadata: { idempotencyKey: "invoice:22222222-2222-4222-8222-222222222222:At4g00" },
  });
  expect(calls[9]).toMatchObject({
    call: { target: { type: "mail.mailbox", id: "Mb4g00" }, input: { expectedRevision: 4, addTagIds: ["Tag123"] } },
  });
  const failedCalls: string[] = [];
  const failedModule = await import(
    `data:text/javascript;base64,${Buffer.from(`${result.bundle}\n// terminal fixture`).toString("base64")}`
  );
  await expect(
    failedModule["event:mail.message.received@1"](
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "mail.message.received",
        version: 1,
        source: "mail",
        time: "2026-11-07T12:00:00.000Z",
        subject: { type: "mail.message", id: "Ms4g00" },
        place: { type: "mail.mailbox", id: "Mb4g00" },
        data: { receiptId: "22222222-2222-4222-8222-222222222222" },
      },
      {
        call: async (_operation: string, input: CodeSdkInvocation) => {
          failedCalls.push(input.call.capability);
          throw new Error("mail_message_hydration_failed");
        },
      },
    ),
  ).rejects.toThrow("mail_message_hydration_failed");
  expect(failedCalls).toEqual(["mail.message.read"]);
}, 30_000);

test("each building block types its props: a wrong prop, value or child text is a type error", async () => {
  // Each block sits in its right place, so only its own props can be wrong.
  const form = (field: string) => `<Form title="F" action="/x" submit="Go">${field}</Form>`;
  const wrong = [
    form('<Field.Number name="n" label="N" value="three" />'),
    form('<Field.Checkbox name="c" label="C" value="yes" />'),
    form('<Field.Text name="t" label="T">text</Field.Text>'),
    form('<Field.Select name="s" label="S"><Option value="v" /></Field.Select>'),
    '<Stats><Stat label="S" value={1} delta={{ value: 1, better: "sideways" }} /></Stats>',
    "<Stats items={[]} />",
    '<Table title="T" rows={[]}><Column key="a" /></Table>',
    '<Detail title="D"><Item label="L" /></Detail>',
    '<Form title="F" action="/x" submit="Go" fields={[]} />',
    '<Chart.Bar title="C" data={[{ label: "A", value: 1 }]} description={{ kind: "bar" }} />',
    '<Chart.Line title="L" series="none" />',
    '<Chart description={{ kind: "bar", title: "C", data: [] }} />',
    '<Chart.Empty title="Orders" />',
  ];
  const routes = wrong.map((block, index) => `app.get("/${index}", c => c.page(<Page title="P">${block}</Page>));`);
  // The description is Cloud's transport, not a way to build pages.
  wrong.push('c.page({ version: 1, kind: "Page", title: "P", children: [] })');
  routes.push(`app.get("/object", c => c.page({ version: 1, kind: "Page", title: "P", children: [] }));`);
  const result = await checkCode(
    {
      ...base,
      entry: "code.tsx",
      limits: { ...CODE_CHECK_LIMITS, checkMs: 30000 },
      files: {
        "code.tsx": `import { app, jsx, Page, Stats, Stat, Table, Column, Detail, Item, Option, Form, Field, Chart } from "@sdk";\n${routes.join("\n")}`,
      },
    },
    host,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const lines = new Set(result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("TS")).map((diagnostic) => diagnostic.line));
  // Line 1 is the import; block N sits on line N + 2.
  expect(wrong.filter((_, index) => !lines.has(index + 2))).toEqual([]);
}, 60000);
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
app.schedule({ at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin", name: "reminder", title: "Send summary" }, async () => {
  const { data: result } = await core.ai.generate({ task: "daily.summary", prompt: "Summarize the supplied notes.", input: { notes: "Delivery received." }, output: { type: "text", maxChars: 1200 } });
  if (typeof result.output !== "object" || result.output === null || !("text" in result.output) || typeof result.output.text !== "string") throw new Error("Unexpected summary output");
  await chat.message.post({ conversation: "Chat01", body: result.output.text, idempotencyKey: "summary-2026-12-01" });
});
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
      if (operation === "core.ai.generate") return { data: { output: { text: "Summary: delivery received." } } };
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

test("flat app methods retain permission and AI evidence through every supported call form", async () => {
  const core = sdkFixture("core");
  const rechnungen = sdkFixture("rechnungen");
  const sdk = generateCodeSdk(
    [
      {
        ...core,
        types: [...core.types, { ...core.types[0]!, localId: "ai" }],
        queries: core.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId: "ai.generate" } : op)),
      },
      {
        ...rechnungen,
        types: rechnungen.types.map((type) => (type.localId === "workshop" ? { ...type, localId: "incoming" } : type)),
        queries: rechnungen.queries.map((op) => (op.target === "workshop" ? { ...op, target: "incoming" } : op)),
        actions: rechnungen.actions.map((op) => ({
          ...op,
          ...(op.target === "workshop" ? { target: "incoming" } : {}),
          refs: Object.fromEntries(Object.entries(op.refs ?? {}).map(([key, type]) => [key, type === "workshop" ? "incoming" : type])),
        })),
      },
    ],
    { mode: "personal" },
  );
  const forms = [
    "core.ai.generate({});",
    "await core.ai.generate({});",
    "const x = core.ai; await x.generate({});",
    "type Result = Awaited<ReturnType<typeof core.ai.generate>>; await core.ai.generate({});",
    'await core["ai"].generate({});',
    'await core.ai["generate"]({});',
    "await core?.ai.generate({});",
    "await core.ai.generate?.({});",
    'const h = core.ai("resource"); await core.ai.generate({});',
    'await rechnungen.incoming("Invoice001").stock.list({});',
  ];
  for (const body of forms) {
    const checked = await check(
      `import { app, core, rechnungen } from "@sdk";
app.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => { ${body} });
export default app;`,
      { sdk, aiOperations: ["core.ai.generate"], limits: { ...CODE_CHECK_LIMITS, checkMs: 60_000 } },
    );
    if (!checked.ok) throw new Error(`${body}: ${JSON.stringify(checked.diagnostics)}`);
    const resource = body.includes("rechnungen");
    expect(checked.manifest.ai).toBe(!resource);
    expect(checked.manifest.permissions).toMatchObject([
      {
        operation: resource ? "rechnungen.stock.list" : "core.ai.generate",
        target: resource ? { type: "rechnungen.incoming", id: "Invoice001" } : null,
        entrypoints: ["weekly"],
      },
    ]);
    expect(checked.manifest.permissions).toHaveLength(1);
    const calls: CodeSdkInvocation[] = [];
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(`${checked.bundle}\n// ${body}`).toString("base64")}`);
    await loaded.weekly(null, {
      async call(_operation: string, invocation: CodeSdkInvocation) {
        calls.push(invocation);
        return { data: [] };
      },
    });
    expect(calls.map((call) => ({ operation: call.call.capability, target: call.call.target }))).toEqual([
      {
        operation: checked.manifest.permissions[0]!.operation,
        target: resource ? { type: "rechnungen.incoming", id: "Invoice001" } : null,
      },
    ]);
  }
}, 180_000);

test("flat SDK methods cannot be detached or reached through the removed app factory", async () => {
  const core = sdkFixture("core");
  const sdk = generateCodeSdk(
    [{ ...core, queries: core.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId: "ai.generate" } : op)) }],
    { mode: "personal" },
  );
  for (const body of [
    "const f = core.ai.generate; await f({});",
    "await core.ai.generate.call(null, {});",
    "await core.ai.generate.apply(null, [{}]);",
    "const f = core.ai.generate.bind(null); await f({});",
    "const { generate: f } = core.ai; await f({});",
    'const f = core["ai"]["generate"]; await f({});',
    "await core.app().ai.generate({});",
  ]) {
    const checked = await check(
      `import { app, core } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, async () => { ${body} }); export default app;`,
      { sdk, aiOperations: ["core.ai.generate"] },
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok)
      expect(checked.diagnostics.some((d) => ["code_detached_sdk_method", "code_unresolved_call"].includes(d.code))).toBe(true);
  }
}, 60_000);

test("flat namespaces retain SDK identity through inferred const aliases only", async () => {
  const manifests = ["alpha", "beta"].map((id) => {
    const fixture = sdkFixture(id);
    return { ...fixture, queries: fixture.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId: "ai.generate" } : op)) };
  });
  const sdk = generateCodeSdk(manifests, { mode: "personal" });
  for (const body of [
    "const x = Date.now() > 0 ? alpha.ai : beta.ai; await x.generate({});",
    "const x = Date.now() > 0 ? alpha : beta; await x.ai.generate({});",
    "const x: { generate(input: {}): Promise<unknown> } = alpha.ai; await x.generate({});",
    "const x = alpha.ai as { generate(input: {}): Promise<unknown> }; await x.generate({});",
    "function invoke(x: { generate(input: {}): Promise<unknown> }) { return x.generate({}); } await invoke(alpha.ai);",
    "const box = { x: alpha.ai }; await box.x.generate({});",
  ]) {
    const checked = await check(
      `import { app, alpha, beta } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, async () => { ${body} }); export default app;`,
      { sdk, aiOperations: ["beta.ai.generate"] },
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.diagnostics.some((d) => d.code === "code_unresolved_call")).toBe(true);
  }
}, 60_000);

test("app-owned Code attributes owner and export namespace aliases", async () => {
  const core = sdkFixture("core");
  const sdk = generateCodeSdk(
    [
      {
        ...core,
        types: [...core.types, { ...core.types[0]!, localId: "ai" }],
        queries: core.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId: "ai.generate" } : op)),
      },
    ],
    { mode: "resource", owner: { kind: "app", appId: "core" } },
  );
  for (const root of ["owner", "core"]) {
    const body = `await ${root}.ai.generate({}); const namespace = ${root}; const x = namespace.ai; await x.generate({});`;
    const checked = await check(
      `import { app, core, owner } from "@sdk";
app.schedule({ cron: "0 8 * * 1", name: "weekly" }, async () => { ${body} }); export default app;`,
      { sdk, aiOperations: ["core.ai.generate"] },
    );
    if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
    expect(checked.manifest.ai).toBe(true);
    expect(checked.manifest.permissions).toMatchObject([
      { operation: "core.ai.generate", target: null, entrypoints: ["weekly"] },
      { operation: "core.ai.generate", target: null, entrypoints: ["weekly"] },
    ]);
    expect(checked.manifest.permissions).toHaveLength(2);
    const calls: CodeSdkInvocation[] = [];
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(checked.bundle).toString("base64")}`);
    await loaded.weekly(null, {
      async call(_operation: string, invocation: CodeSdkInvocation) {
        calls.push(invocation);
        return { data: [] };
      },
    });
    expect(calls.map((call) => ({ operation: call.call.capability, target: call.call.target }))).toEqual([
      { operation: "core.ai.generate", target: null },
      { operation: "core.ai.generate", target: null },
    ]);
    for (const escape of [
      `const x: { generate(input: {}): Promise<unknown> } = ${root}.ai; await x.generate({});`,
      `const box = { x: ${root}.ai }; await box.x.generate({});`,
    ]) {
      const rejected = await check(
        `import { app, core, owner } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, async () => { ${escape} }); export default app;`,
        { sdk },
      );
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.diagnostics.some((d) => d.code === "code_unresolved_call")).toBe(true);
    }
  }
}, 90_000);

test("typed app(id) stays a resource factory and app() is a checker type diagnostic", async () => {
  const fixture = sdkFixture("capabilities");
  const sdk = generateCodeSdk(
    [
      {
        ...fixture,
        types: [...fixture.types, { ...fixture.types[0]!, localId: "app" }],
        queries: fixture.queries.map((op) => (op.localId === "catalog.list" ? { ...op, localId: "search" } : op)),
      },
    ],
    { mode: "personal" },
  );
  const checked = await check(
    `import { app, capabilities } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, async () => {
  const h = capabilities.app("App001");
  const type: "capabilities.app" = h.type;
  const id: "App001" = h.id;
  await capabilities.search({});
}); export default app;`,
    { sdk },
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.manifest.permissions.map((p) => p.operation)).toEqual(["capabilities.search"]);
  const rejected = await check(
    `import { app, capabilities } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, () => { capabilities.app(); }); export default app;`,
    { sdk },
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.diagnostics.some((d) => d.code === "TS2554")).toBe(true);
}, 60_000);

test("SDK property keys and resource values preserve their declaration identity", async () => {
  const core = sdkFixture("core");
  const sdk = generateCodeSdk(
    [
      {
        ...core,
        queries: [
          ...core.queries,
          { ...core.queries.find((op) => op.localId === "catalog.list")!, localId: "ai.generate" },
          { ...core.queries.find((op) => op.localId === "catalog.list")!, localId: "catalog.use", refs: { destination: "workshop" } },
        ],
      },
      sdkFixture(),
    ],
    { mode: "resource", owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } } },
  );
  const accepted: string[] = [];
  for (const body of [
    `const ns: "catalog" = JSON.parse('"ai"'); const method: "list" = JSON.parse('"generate"'); await core[ns][method]({});`,
    `const method: "list" = JSON.parse('"export"'); await owner.stock[method]({});`,
    `function run(h: { stock: { list(input: {}): Promise<unknown> } }) { return h.stock.list({}); } await run(owner);`,
    `function run(h: { stock: { list(input: {}): Promise<unknown> } }) { return h.stock.list({}); } await run(work_shop.workshop("one"));`,
    `function run(f: (id: string) => { stock: { list(input: {}): Promise<unknown> } }) { return f("one").stock.list({}); } await run(work_shop.workshop);`,
    `function run(f: (id: string) => { item: { inspect(input: {}): Promise<unknown> } }) { return f("one").item.inspect({}); } await run(work_shop.item);`,
    `function run(input: { destination: { stock: { list(input: {}): Promise<unknown> } } }) { return input.destination.stock.list({}); }
     const fake: { use: typeof core.catalog.use } = { use: async input => { await run(input); return { data: [] }; } };
     await fake.use({ destination: core.workshop("one") });`,
    `const h: { stock: { list(input: {}): Promise<unknown> } } = owner; await h.stock.list({});`,
    `const stock: { list(input: {}): Promise<unknown> } = owner.stock; await stock.list({});`,
  ]) {
    const checked = await check(
      `import { app, core, owner, work_shop } from "@sdk";
app.schedule({ cron: "0 8 * * 1" }, async () => { ${body} }); export default app;`,
      { sdk, aiOperations: ["core.ai.generate"] },
    );
    if (checked.ok) accepted.push(body);
    else expect(checked.diagnostics.some((d) => d.code === "code_unresolved_call")).toBe(true);
  }
  expect(accepted).toEqual([]);
}, 90_000);

test("resource aliases and SDK refs keep their complete evidence", async () => {
  const checked = await check(
    schedule(`
    const factory = work_shop.workshop;
    const destination = factory("one");
    const h = owner;
    type IdOnly = Pick<typeof owner, "id">;
    const identity: IdOnly = { id: owner.id };
    function label(value: IdOnly) { return value.id; }
    label(identity);
    await h.stock.list({});
    await h.item.move({ itemId: "item-one", destination });
  `),
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.manifest.permissions.map((p) => ({ operation: p.operation, target: p.target }))).toEqual([
    { operation: "work-shop.stock.list", target: { type: "work-shop.workshop", id: "owner-shop" } },
    { operation: "work-shop.item.move", target: { type: "work-shop.workshop", id: "owner-shop" } },
    { operation: "work-shop.item.move", target: { type: "work-shop.workshop", id: "one" } },
  ]);
}, 30_000);

test("typed middleware variables reject unknown keys and wrong values in the real compiler", async () => {
  const source = (body: string) => `import { app } from "@sdk";
const routes = app.use<{ kunde: { id: string } }>(async (c, next) => {
  c.set("kunde", { id: "one" }); return next();
});
routes.get("/", c => { ${body} return c.text(c.get("kunde").id); });`;
  expect(await check(source('const id: string = c.get("kunde").id;'))).toMatchObject({ ok: true });
  for (const body of [
    'c.set("kunde", 42);',
    'c.set("other", { id: "one" });',
    'c.get("other");',
    'const id: number = c.get("kunde").id;',
  ]) {
    const result = await check(source(body));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: expect.stringMatching(/^TS\d+$/) })]));
  }
  expect(await check('import { app } from "@sdk"; app.get("/", c => c.json(c.get("undeclared")));')).toMatchObject({ ok: false });
}, 30_000);

test("checked middleware bundles preserve request variables, public identity and capability evidence", async () => {
  const checked = await check(`import { app, work_shop } from "@sdk";
app.get("/before", c => c.text("before"));
const routes = app.use<{ order: string[] }>(async (c, next) => {
  c.set("order", ["outer"]); const response = await next(); return response;
});
routes.use("/private", async (c, next) => {
  c.get("order").push("inner");
  await work_shop.catalog.list({});
  return next();
});
routes.get("/private/:id", c => c.json({ order: c.get("order"), id: c.req.param("id") }));
routes.get("/public", c => c.json({ user: c.user, order: c.get("order") }), { public: true });`);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  expect(checked.manifest.permissions).toMatchObject([{ operation: "work-shop.catalog.list", entrypoints: ["route:GET:/private/:id"] }]);
  let sequence = 0;
  const run = async (entrypoint: string, input: unknown) => {
    // The runner loads a fresh bundle and binds the bridge once for each request.
    const path = join(directory, `checked-middleware-${sequence++}.mjs`);
    await writeFile(path, checked.bundle);
    const module = await import(path);
    return module[entrypoint](input, bridge);
  };
  const calls: string[] = [];
  const bridge = {
    call: async (operation: string) => {
      calls.push(operation);
      return { data: [] };
    },
  };
  const request = {
    method: "GET",
    path: "/private/one",
    query: "",
    params: { id: "one" },
    contentType: "text/plain",
    body: "",
    user: { id: "u_one", username: "one", groupIds: [], groupNames: [], kind: "user", name: "One" },
  };
  expect(await run("route:GET:/before", { ...request, path: "/before" })).toEqual({ kind: "text", status: 200, body: "before" });
  expect(calls).toEqual([]);
  for (let i = 0; i < 2; i++) {
    expect(await run("route:GET:/private/:id", request)).toEqual({
      kind: "json",
      status: 200,
      body: JSON.stringify({ order: ["outer", "inner"], id: "one" }),
    });
  }
  expect(calls).toEqual(["work-shop.catalog.list", "work-shop.catalog.list"]);
  expect(await run("route:GET:/public", { ...request, path: "/public" })).toEqual({
    kind: "json",
    status: 200,
    body: JSON.stringify({ user: null, order: ["outer"] }),
  });
}, 30_000);
