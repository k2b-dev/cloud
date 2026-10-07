import { expect, test } from "bun:test";
import { defineTool, type Message, nessi, type Provider, type ProviderRequest, type StoreEntry } from "@k2b/nessi";
import { z } from "zod";
import { acceptCanonicalToolNames } from "./tool-call-names";

/** Calls `name` once, then answers with text; records every request it receives. */
const callingProvider = (name: string, requests: ProviderRequest[]): Provider => ({
  name: "fixture",
  family: "openai-compatible",
  model: "fixture",
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  async complete() {
    throw new Error("Unexpected completion");
  },
  async *stream(request) {
    requests.push(structuredClone({ ...request, signal: undefined }));
    if (requests.length === 1) {
      yield { type: "block_start", blockId: "call", index: 0, kind: "tool_call", callId: "call-1", name };
      yield { type: "block_end", blockId: "call", index: 0, block: { type: "tool_call", id: "call-1", name, args: {} } };
      yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
    } else {
      yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
      yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
      yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
    }
  },
});

const run = async (calledName: string) => {
  const requests: ProviderRequest[] = [];
  const executed: string[] = [];
  const entries: StoreEntry[] = [];
  const tool = defineTool({ name: "contacts__query__list", description: "List contacts", inputSchema: z.object({}) }).server(async () => {
    executed.push("contacts__query__list");
    return { data: [] };
  });
  const loop = nessi({
    loopId: "loop",
    provider: acceptCanonicalToolNames(callingProvider(calledName, requests), new Map([["contacts__query__list", "contacts.list"]])),
    systemPrompt: "",
    input: "List my contacts",
    tools: [tool],
    maxTurns: 3,
    store: {
      load: async () => entries,
      append: async (message) => {
        entries.push({ seq: entries.length + 1, kind: "message", message });
      },
    },
  });
  for await (const _event of loop);
  const toolResult = (messages: Message[]) => messages.find((message) => message.role === "tool_result");
  return {
    executed,
    stored: toolResult(entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))),
    requests,
    toolResult,
  };
};

test("a call to a loaded app operation by its capability ID runs under its provider name", async () => {
  const { executed, stored } = await run("contacts.list");

  expect(executed).toEqual(["contacts__query__list"]);
  expect(stored).toMatchObject({ role: "tool_result", name: "contacts__query__list", isError: false });
});

test("a call to a name the turn does not offer tells the model how to find a callable name", async () => {
  const { executed, stored, requests, toolResult } = await run("code_run");

  expect(executed).toEqual([]);
  // The stored history keeps nessi's own result; only the model's view gains the guidance.
  expect(stored).toMatchObject({ name: "code_run", isError: true, result: "Unknown tool: code_run" });
  expect(toolResult(requests[1]!.messages)).toMatchObject({
    name: "code_run",
    isError: true,
    result: expect.stringContaining("Unknown tool: code_run. Call only tools offered in this turn"),
  });
});
