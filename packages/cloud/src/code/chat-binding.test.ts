import { expect, test } from "bun:test";
import { z } from "zod";
import { chatCapabilities } from "../../../chat/src/capabilities";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { compileCapabilityManifest } from "../capabilities/testing";
import { defineCapabilities } from "../contracts/capabilities";
import { codeAiToolCovered, createCodeAiTools } from "./ai-tools";
import { CODE_BOUND_CHAT_ID } from "./bound-chat";
import { analyzeCode } from "./checker-analysis";
import { CodeAiToolBindingSchema } from "./file-ref";
import { generateCodeSdk } from "./generator";
import { createCodeTestBridge } from "./test-bridge";
import type { CodeSdkInvocation, CodeSdkOptions } from "./types";

const manifest = compileCapabilityManifest(
  "core",
  defineCapabilities({
    protocolVersion: 2,
    types: { "ai.chat": { title: "Chat", description: "A person's chat." } },
    queries: { "ai.generate": aiGenerationQuery },
    actions: {
      "ai.chat.send": {
        title: "Write to Gustav",
        description: "Send instructions and source data to an own chat.",
        target: "ai.chat",
        input: z.strictObject({
          text: z.string().describe("Fixed instruction."),
          context: z.string().optional().describe("Untrusted source data."),
        }),
        data: z.strictObject({ receipt: z.string() }),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        approval: "none",
        run: () => ({ ok: true, data: { data: { receipt: "fictional" } } }),
      },
    },
  }),
);
const sdk = (options: CodeSdkOptions = { mode: "personal" }) => generateCodeSdk([manifest], options);

test("bound Gustav chat and the Chat application keep separate SDK exports and invocations", async () => {
  const generated = generateCodeSdk([manifest, compileCapabilityManifest("chat", chatCapabilities)], { mode: "personal" });
  expect(generated.manifest.apps.find((app) => app.appId === "chat")?.exportName).toBe("_chat");
  const calls: CodeSdkInvocation[] = [];
  const module = await import(`data:text/javascript;base64,${Buffer.from(generated.runtime).toString("base64")}`);
  module.__codeSdk.bind({
    call: async (_operation: string, input: CodeSdkInvocation) => {
      calls.push(input);
      return {};
    },
  });
  await module.chat.send({ text: "Review the supplied notes.", idempotencyKey: "gustav-note" });
  await module._chat.message.post({ conversation: "Cnv001", body: "Team note", idempotencyKey: "team-note" });
  expect(calls).toEqual([
    {
      call: {
        capability: "core.ai.chat.send",
        target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
        refs: {},
        input: { text: "Review the supplied notes." },
      },
      metadata: { idempotencyKey: "gustav-note" },
    },
    {
      call: { capability: "chat.message.post", target: null, refs: {}, input: { conversation: "Cnv001", body: "Team note" } },
      metadata: { idempotencyKey: "team-note" },
    },
  ]);
});

test("bound send stays bound through generated AI tools and requires the dynamic checked permission", async () => {
  const generated = sdk();
  const calls: CodeSdkInvocation[] = [];
  const module = await import(`data:text/javascript;base64,${Buffer.from(`// AI tool fixture\n${generated.runtime}`).toString("base64")}`);
  module.__codeSdk.bind({
    call: async (_operation: string, input: CodeSdkInvocation) => {
      calls.push(input);
      return { text: "Fictional answer" };
    },
  });
  await module.core.ai.generate({ tools: [module.chat.send] });
  const input = z.object({ tools: z.array(CodeAiToolBindingSchema) }).parse(calls[0]?.call.input);
  expect(input.tools).toEqual([{ capability: "core.ai.chat.send", target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID } }]);
  const permissions = [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 }];
  const [tool] = await createCodeAiTools({
    bindings: input.tools,
    permissions,
    invoke: async (invocation) => {
      calls.push(invocation);
      return { receipt: "fictional" };
    },
    registerFiles: () => {},
    requestId: "bound-tool",
    getCapability: async () => ({
      appId: "core",
      appName: "Core",
      appIcon: "ti ti-folder",
      appDescription: "Fixture",
      manifest,
      endpoint: "http://core",
    }),
  });
  await tool!.execute(
    { text: "Review the facts." },
    {
      signal: new AbortController().signal,
      requestApproval: async () => false,
      requestClientTool: async () => {
        throw new Error("No client tool");
      },
    },
  );
  expect(calls[1]).toEqual({
    call: {
      capability: "core.ai.chat.send",
      target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
      refs: {},
      input: { text: "Review the facts." },
    },
    metadata: { idempotencyKey: "ai:bound-tool:1" },
  });
  const binding = input.tools[0]!;
  expect(codeAiToolCovered(binding, [{ operation: binding.capability, target: { type: "core.ai.chat", id: "Literal433" } }])).toBe(false);
  expect(codeAiToolCovered({ ...binding, capability: "core.ai.generate" }, permissions)).toBe(false);
  expect(codeAiToolCovered({ ...binding, target: { type: "core.ai.chat", id: "Claimed433" } }, permissions)).toBe(true);
  const result = analyzeCode({
    sdk: generated,
    entry: "code.ts",
    aiOperations: ["core.ai.generate", "core.ai.chat.send"],
    files: {
      "code.ts": `import { app, chat, core } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "morning" }, async () => {
  await core.ai.generate({ task: "briefing", prompt: "Review", input: {}, output: { type: "text", maxChars: 100 }, tools: [chat.send] });
}); export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions).toContainEqual(
    expect.objectContaining({ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } }),
  );
});

test("the personal chat export preserves send's generated signature and uses the shared sentinel", async () => {
  const generated = sdk();
  expect(generated.declarations).toContain(`export declare const chat: CodeHandle<"core.ai.chat", "${CODE_BOUND_CHAT_ID}">`);
  expect(generated.declarations).toContain("readonly send:");
  const calls: CodeSdkInvocation[] = [];
  const module = await import(`data:text/javascript;base64,${Buffer.from(generated.runtime).toString("base64")}`);
  module.__codeSdk.bind({
    call: async (_operation: string, input: CodeSdkInvocation) => {
      calls.push(input);
      return { receipt: "fictional" };
    },
  });
  await module.chat.send({ text: "Summarise this data.", context: "Fictional facts", idempotencyKey: "  morning-1  " });
  expect(calls).toEqual([
    {
      call: {
        capability: "core.ai.chat.send",
        target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
        refs: {},
        input: { text: "Summarise this data.", context: "Fictional facts" },
      },
      metadata: { idempotencyKey: "morning-1" },
    },
  ]);
  expect(module.chat.id).toBe(CODE_BOUND_CHAT_ID);
  expect(module.chat.type).toBe("core.ai.chat");
  expect(generated.runtime).toContain(`const CODE_BOUND_CHAT_ID = "${CODE_BOUND_CHAT_ID}";`);
  await expect(module.chat.send({ text: "Instructions" })).rejects.toMatchObject({ code: "code_sdk_idempotency_required" });
});

test.each([{ mode: "code_run" }, { mode: "resource", owner: { kind: "app", appId: "core" } }] satisfies CodeSdkOptions[])(
  "%j has no bound chat export",
  async (options) => {
    const generated = sdk(options);
    expect(generated.declarations).not.toContain("export declare const chat:");
    const module = await import(`data:text/javascript;base64,${Buffer.from(generated.runtime).toString("base64")}`);
    expect(module.chat).toBeUndefined();
  },
);

test.each(["chat.send", "bound.send"])("%s records the ordinary send permission with a dynamic chat target", (method) => {
  const result = analyzeCode({
    sdk: sdk(),
    aiOperations: ["core.ai.chat.send"],
    entry: "code.ts",
    files: {
      "code.ts": `import { app, chat } from "@sdk";
const bound = chat;
app.schedule({ cron: "0 8 * * *", name: "morning" }, async () => {
  await ${method}({ text: "Summarise the data.", idempotencyKey: "morning-1" });
}); export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.ai).toBe(true);
  expect(result.permissions).toEqual([
    expect.objectContaining({ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } }),
  ]);
});

test("fake execution uses the sentinel target for the bound chat without consulting a real destination", async () => {
  const bridge = createCodeTestBridge(sdk().manifest, [
    {
      operation: "core.ai.chat.send",
      target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
      replies: [{ ok: true, data: { receipt: "fictional" } }],
    },
  ]);
  const invocation = {
    call: {
      capability: "core.ai.chat.send",
      target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
      refs: {},
      input: { text: "Review the facts." },
    },
    metadata: { idempotencyKey: "morning-1" },
  };
  expect(await bridge.call("core.ai.chat.send", invocation)).toEqual({ receipt: "fictional" });
  expect(await bridge.call("core.ai.chat.send", invocation)).toEqual({ receipt: "fictional" });
  expect(bridge.calls()[1]?.replayed).toBe(true);
  expect(bridge.failure()).toBeNull();
  await expect(bridge.call("core.ai.chat.send", { ...invocation, call: { ...invocation.call, target: null } })).rejects.toMatchObject({
    code: "code_test_invalid_call",
  });
});

test.each([CODE_BOUND_CHAT_ID, "Literal433"])("explicit chat handle %s records its actual destination semantics", (id) => {
  const result = analyzeCode({
    sdk: sdk(),
    aiOperations: ["core.ai.chat.send"],
    entry: "code.ts",
    files: {
      "code.ts": `import { app, core } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "morning" }, async () => {
  await core.ai.chat("${id}").send({ text: "Review", idempotencyKey: "morning" });
}); export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions).toEqual([
    expect.objectContaining({
      operation: "core.ai.chat.send",
      target: { type: "core.ai.chat", id: id === CODE_BOUND_CHAT_ID ? null : id },
    }),
  ]);
});
