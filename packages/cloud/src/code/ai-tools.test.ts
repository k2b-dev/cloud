import { expect, mock, test } from "bun:test";
import { z } from "zod";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { compileCapabilityManifest } from "../capabilities/testing";
import { CapabilityFileMetadataSchema } from "../contracts/capabilities";
import { createCodeAiTools } from "./ai-tools";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkInvocation } from "./types";

const fixture = sdkFixture();
const read = {
  title: "Read",
  description: "Read evidence.",
  input: z.object({}).strict(),
  data: z.object({}).strict(),
  openWorld: false,
  run: () => ({ ok: true as const, data: { data: {} } }),
};
const core = compileCapabilityManifest("core", {
  protocolVersion: 2,
  queries: { "ai.generate": aiGenerationQuery, catalog: read, "catalog.list": read },
});
const sdk = generateCodeSdk([fixture, core], { mode: "personal" });
const request = '{ task: "extract", prompt: "Use evidence", input: {}, output: { type: "text", maxChars: 20 }, tools: TOOLS }';
const analyze = (code: string) =>
  analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: ["core.ai.generate"],
    files: {
      "code.ts": `import { app, core, work_shop, http } from "@sdk"; app.schedule({ cron: "0 0 * * *" }, async () => { ${code} }); export default app;`,
    },
  });

test("only literal AI tools admit detached SDK methods and collect all target and approval evidence", () => {
  const result = analyze(
    `await core.ai.generate(${request.replace("TOOLS", '[work_shop.catalog.list, work_shop.workshop("fixed").stock.list]')});`,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: "core.ai.generate", target: null }),
      expect.objectContaining({ operation: "work-shop.catalog.list", target: null }),
      expect.objectContaining({ operation: "work-shop.stock.list", target: { type: "work-shop.workshop", id: "fixed" } }),
    ]),
  );
  expect(result.ai).toBe(true);
  const aliases = analyze(
    `const ai = core.ai; const catalog = work_shop.catalog; await ai.generate(${request.replace("TOOLS", "[catalog.list]")});`,
  );
  expect(aliases.diagnostics).toEqual([]);
  expect(aliases.permissions).toContainEqual(expect.objectContaining({ operation: "work-shop.catalog.list", target: null }));
  const callable = analyze(`await core.ai.generate(${request.replace("TOOLS", "[core.catalog]")});`);
  expect(callable.diagnostics).toEqual([]);
  expect(callable.permissions).toContainEqual(expect.objectContaining({ operation: "core.catalog", target: null }));
  for (const code of [
    "const detached = work_shop.catalog.list;",
    "const { list } = work_shop.catalog;",
    `const tools = [work_shop.catalog.list]; await core.ai.generate(${request.replace("TOOLS", "tools")});`,
    "const data = { tools: [work_shop.catalog.list] };",
    "const detached = core.catalog;",
    `await core.ai.generate(${request.replace("TOOLS", "[http.fetch]")});`,
    `await core.ai.generate(${request.replace("TOOLS", '[work_shop.workshop("fixed").item.move]')});`,
  ])
    expect(analyze(code).diagnostics.length).toBeGreaterThan(0);
});

test("runtime serializes registered app and target-bound methods and rejects detached copies or forgeries", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const call = mock(async (_capability: string, input: unknown) => input);
  runtime.__codeSdk.bind({ call });
  const args = { task: "extract", prompt: "Read", input: {}, output: { type: "text", maxChars: 20 } };
  await runtime.core.ai.generate({ ...args, tools: [runtime.work_shop.catalog.list, runtime.work_shop.workshop("fixed").stock.list] });
  expect(call.mock.calls[0]![1]).toMatchObject({
    call: {
      capability: "core.ai.generate",
      input: {
        tools: [
          { capability: "work-shop.catalog.list", target: null },
          { capability: "work-shop.stock.list", target: { type: "work-shop.workshop", id: "fixed" } },
        ],
      },
    },
  });
  for (const fake of [
    "work-shop.catalog.list",
    () => {},
    { capability: "work-shop.catalog.list", target: null },
    runtime.work_shop.catalog.list.bind(null),
    Object.assign(() => {}, runtime.work_shop.catalog.list),
  ])
    await expect(runtime.core.ai.generate({ ...args, tools: [fake] })).rejects.toThrow("code_ai_tool_invalid");
  expect(call).toHaveBeenCalledTimes(1);
});

test("tool admission narrows to checked targets, exposes only domain input and keeps the dispatch target fixed", async () => {
  const invoke = mock(async () => ({ data: { rows: [] } }));
  const target = { type: "work-shop.workshop", id: "fixed" };
  const options = {
    bindings: [{ capability: "work-shop.stock.list", target }],
    permissions: [{ operation: "work-shop.stock.list", target, file: "code.ts", line: 1 }],
    invoke,
    registerFiles: () => {},
    requestId: "run",
    getCapability: async () => ({
      appId: "work-shop",
      appName: "Workshop",
      appIcon: "ti ti-folder",
      appDescription: "Fixture",
      manifest: fixture,
      endpoint: "http://work-shop",
    }),
  };
  const [tool] = await createCodeAiTools(options);
  expect(z.toJSONSchema(tool!.def.inputSchema).properties).not.toHaveProperty("target");
  const result = await tool!.execute(
    { cursor: "next" },
    {
      signal: new AbortController().signal,
      requestApproval: async () => false,
      requestClientTool: async () => {
        throw new Error("No client tool");
      },
    },
  );
  expect(invoke).toHaveBeenCalledWith({
    call: { capability: "work-shop.stock.list", target, refs: {}, input: { cursor: "next" } },
    metadata: {},
  });
  expect(result).toEqual({ untrusted_tool_result: { data: { rows: [] } } });
  await expect(
    createCodeAiTools({ ...options, bindings: [{ capability: "work-shop.stock.list", target: { ...target, id: "foreign" } }] }),
  ).rejects.toThrow("code_ai_tool_not_checked");
});

test("distinct action executions have distinct idempotency keys even if a provider reuses call IDs", async () => {
  const invoke = mock(async (_input: CodeSdkInvocation) => ({ data: { id: "created" } }));
  const target = { type: "work-shop.workshop", id: "fixed" };
  const [tool] = await createCodeAiTools({
    bindings: [{ capability: "work-shop.item.create", target }],
    permissions: [{ operation: "work-shop.item.create", target, file: "code.ts", line: 1 }],
    invoke,
    registerFiles: () => {},
    requestId: "run",
    getCapability: async () => ({
      appId: "work-shop",
      appName: "Workshop",
      appIcon: "ti ti-folder",
      appDescription: "Fixture",
      manifest: fixture,
      endpoint: "http://work-shop",
    }),
  });
  const context = {
    callId: "call_0",
    signal: new AbortController().signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("No client tool");
    },
  };
  await tool!.execute({ title: "First" }, context);
  await tool!.execute({ title: "Second" }, context);
  expect(invoke.mock.calls[0]![0].metadata.idempotencyKey).not.toBe(invoke.mock.calls[1]![0].metadata.idempotencyKey);
});

test("stream-write tools accept the SDK FileRef projection and preserve it for the shared dispatcher", async () => {
  const manifest = compileCapabilityManifest("imports", {
    protocolVersion: 2,
    actions: {
      import: {
        ...read,
        input: z.object({ file: CapabilityFileMetadataSchema }).strict(),
        destructive: false,
        idempotency: "required",
        stream: {
          direction: "write",
          maxBytes: 100,
          write: async () => ({ ok: true, data: { data: {} } }),
          status: async () => ({ state: "open" }),
          abort: async () => {},
        },
      },
    },
  });
  const invoke = mock(async (_input: CodeSdkInvocation) => ({}));
  const [tool] = await createCodeAiTools({
    bindings: [{ capability: "imports.import", target: null }],
    permissions: [{ operation: "imports.import", target: null, file: "code.ts", line: 1 }],
    invoke,
    registerFiles: () => {},
    requestId: "run",
    getCapability: async () => ({
      appId: "imports",
      appName: "Imports",
      appIcon: "ti ti-file",
      appDescription: "Fixture",
      manifest,
      endpoint: "http://imports",
    }),
  });
  const file = { id: "sealed-ref-already-seen", mediaType: "text/plain", size: 5 };
  expect(tool!.def.inputSchema.safeParse({ file }).success).toBe(true);
  expect(tool!.def.inputSchema.safeParse({ file: { mediaType: file.mediaType, size: file.size } }).success).toBe(false);
  await tool!.execute(tool!.def.inputSchema.parse({ file }), {
    signal: new AbortController().signal,
    requestApproval: async () => false,
    requestClientTool: async () => {
      throw new Error("No client tool");
    },
  });
  expect(invoke.mock.calls[0]![0].call.input).toEqual({ file });
});
