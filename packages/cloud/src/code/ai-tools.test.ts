import { expect, mock, test } from "bun:test";
import { z } from "zod";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { compileCapabilityManifest } from "../capabilities/testing";
import { createCodeAiTools } from "./ai-tools";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const fixture = sdkFixture();
const core = compileCapabilityManifest("core", { protocolVersion: 2, queries: { "ai.generate": aiGenerationQuery } });
const sdk = generateCodeSdk([fixture, core], { mode: "personal" });
const request = '{ task: "extract", prompt: "Use evidence", input: {}, output: { type: "text", maxChars: 20 }, tools: TOOLS }';
const analyze = (code: string) =>
  analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: ["core.ai.generate"],
    files: {
      "code.ts": `import { app, core, work_shop, http } from "@sdk"; app.schedule("0 0 * * *", async () => { ${code} }); export default app;`,
    },
  });

test("only literal AI tools admit detached SDK methods and collect all target and approval evidence", () => {
  const result = analyze(
    `await core.app().ai.generate(${request.replace("TOOLS", '[work_shop.app().catalog.list, work_shop.workshop("fixed").stock.list]')});`,
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
  for (const code of [
    "const detached = work_shop.app().catalog.list;",
    "const { list } = work_shop.app().catalog;",
    `const tools = [work_shop.app().catalog.list]; await core.app().ai.generate(${request.replace("TOOLS", "tools")});`,
    "const data = { tools: [work_shop.app().catalog.list] };",
    `await core.app().ai.generate(${request.replace("TOOLS", "[http.fetch]")});`,
    `await core.app().ai.generate(${request.replace("TOOLS", '[work_shop.workshop("fixed").item.move]')});`,
  ])
    expect(analyze(code).diagnostics.length).toBeGreaterThan(0);
});

test("runtime serializes registered app and target-bound methods and rejects detached copies or forgeries", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  const call = mock(async (_capability: string, input: unknown) => input);
  runtime.__codeSdk.bind({ call });
  const args = { task: "extract", prompt: "Read", input: {}, output: { type: "text", maxChars: 20 } };
  await runtime.core
    .app()
    .ai.generate({ ...args, tools: [runtime.work_shop.app().catalog.list, runtime.work_shop.workshop("fixed").stock.list] });
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
    runtime.work_shop.app().catalog.list.bind(null),
    Object.assign(() => {}, runtime.work_shop.app().catalog.list),
  ])
    await expect(runtime.core.app().ai.generate({ ...args, tools: [fake] })).rejects.toThrow("code_ai_tool_invalid");
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
  await tool!.execute(
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
  await expect(
    createCodeAiTools({ ...options, bindings: [{ capability: "work-shop.stock.list", target: { ...target, id: "foreign" } }] }),
  ).rejects.toThrow("code_ai_tool_not_checked");
});
