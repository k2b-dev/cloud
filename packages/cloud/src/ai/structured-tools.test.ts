import { expect, mock, test } from "bun:test";
import { defineTool, type Provider } from "@k2b/nessi";
import type { GenerateRequest } from "@k2b/nessi/ai";
import { z } from "zod";
import { streamAnswer } from "./answer-stream.test-fixture";
import { runStructuredTools } from "./structured-tools";

function fixture(turns: Array<Array<{ name: string; args: Record<string, unknown> }>>) {
  const requests: GenerateRequest[] = [];
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: true, thinking: false, usage: true },
    contextWindow: 100_000,
    async *stream(request) {
      requests.push(request);
      const calls = turns[requests.length - 1] ?? [];
      yield* streamAnswer({
        message: {
          role: "assistant",
          content: calls.map((call, i) => ({ type: "tool_call" as const, id: `call-${requests.length}-${i}`, ...call })),
        },
        usage: { input: 10, output: 2, total: 12 },
        finishReason: "tool_use",
      });
    },
  };
  const execute = mock(async () => ({ evidence: "untrusted content" }));
  const tool = defineTool({ name: "bound", description: "Read the bound target", inputSchema: z.object({}).strict() }).server(execute);
  const run = () =>
    runStructuredTools({
      task: "fixture",
      provider,
      tools: [tool],
      maxTurns: 3,
      input: "Extract evidence",
      output: z.object({ answer: z.string().max(10) }).strict(),
      additionalInput: () => [{ type: "file", mediaType: "image/png", data: "YQ==" }],
    });
  return { requests, execute, run };
}

test("structured loop executes typed tools and injects acquired images into the next model turn", async () => {
  const f = fixture([[{ name: "bound", args: {} }], [{ name: "submit_result", args: { answer: "ok" } }]]);
  const result = await f.run();
  expect(result.output).toEqual({ answer: "ok" });
  expect(result.usage).toEqual({ input: 20, output: 4, total: 24 });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.requests[1]!.messages)).toContain('"mediaType":"image/png"');
  expect(JSON.stringify(f.requests[1]!.messages)).toContain("untrusted content");
});

test("submission is terminal even when the model sends more tools in the same response", async () => {
  const f = fixture([
    [
      { name: "submit_result", args: { answer: "ok" } },
      { name: "bound", args: {} },
    ],
  ]);
  expect((await f.run()).output).toEqual({ answer: "ok" });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(1);
});

test("invalid output and a model that never submits exhaust the bounded turns", async () => {
  const f = fixture(Array.from({ length: 3 }, () => [{ name: "submit_result", args: { answer: "too long an answer" } }]));
  await expect(f.run()).rejects.toThrow("run limit");
  expect(f.requests).toHaveLength(3);
});
