import { expect, test } from "bun:test";
import { defineTool, memoryStore, nessi, type Provider, type ProviderRequest } from "@k2b/nessi";
import { z } from "zod";
import { __aiExecutorTest } from "./executor";
import { publicAiToolBlock } from "./public-tool-input";
import { acceptCanonicalToolNames } from "./tool-call-names";

test("follow-up and resumed provider requests retain original Code arguments and results after public projection", async () => {
  const source = "export default async () => 'provider-replay-fixture'";
  const cases = [
    { name: "code_run", args: { code: source, inputPaths: ["/input/data.csv"] }, result: { status: "ready" } },
    {
      name: "code_write",
      args: { codeId: "ABCDEF", path: "code.ts", content: source },
      result: { files: [{ path: "code.ts", bytes: 54 }] },
    },
    { name: "code_read", args: { codeId: "ABCDEF" }, result: { version: 1, files: { "code.ts": source } } },
    { name: "code_pull", args: { codeId: "ABCDEF" }, result: { version: 1, files: { "code.ts": source } } },
  ];
  for (const { name, args, result } of cases) {
    const requests: ProviderRequest[] = [];
    const executed: unknown[] = [];
    const store = memoryStore();
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream(request) {
        requests.push(structuredClone({ ...request, signal: undefined }));
        if (requests.length === 1) {
          yield { type: "block_start", blockId: "call", index: 0, kind: "tool_call", callId: "call", name };
          yield { type: "block_end", blockId: "call", index: 0, block: { type: "tool_call", id: "call", name, args } };
          yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
        } else {
          yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
          yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
        }
      },
    };
    const tool = defineTool({ name, description: "Code fixture", inputSchema: z.record(z.string(), z.unknown()) }).server(async (input) => {
      executed.push(structuredClone(input));
      return result;
    });
    const mapper = __aiExecutorTest.createEventMapper(1, []);
    for (const resume of [false, true]) {
      const loop = nessi({
        loopId: "turn",
        store,
        provider: acceptCanonicalToolNames(provider, new Map()),
        systemPrompt: "",
        ...(resume ? {} : { input: "Do the requested work" }),
        tools: [tool],
        maxTurns: 3,
      });
      for await (const event of loop) {
        const blocks = mapper.translate(event).flatMap((op) => (op.type === "block_set" ? [publicAiToolBlock(op.block)] : []));
        expect(JSON.stringify(blocks)).not.toContain(source);
      }
    }
    expect(executed).toEqual([args]);
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      expect(
        request.messages.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "tool_call")),
      ).toMatchObject({ content: [{ type: "tool_call", name, args }] });
      expect(request.messages.find((message) => message.role === "tool_result")).toMatchObject({ name, result });
    }
    expect(
      (await store.load()).some(
        (entry) =>
          entry.kind === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((block) => block.type === "tool_call" && JSON.stringify(block.args) === JSON.stringify(args)),
      ),
    ).toBe(true);
  }
});
