import { describe, expect, spyOn, test } from "bun:test";
import { nessi, type Provider, type ProviderRequest, StructuredOutputError } from "@k2b/nessi";
import { z } from "zod";
import { type TraceContext, trace } from "../services/logging";
import { streamAnswer } from "./answer-stream.test-fixture";
import { AiBackgroundCostError } from "./inference-calls";
import * as quotaProvider from "./quota-provider";
import { runAiStructured, structuredProviderFailure } from "./structured";
import * as structuredRuns from "./structured-runs";

describe("structured provider failures", () => {
  test("restores the original provider error wrapped by nessi direct mode", async () => {
    const failure = new AiBackgroundCostError();
    const provider = {
      name: "test",
      family: "openai-compatible",
      model: "test",
      capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
      stream: async function* () {
        throw failure;
      },
    } satisfies Provider;
    let caught: unknown;
    try {
      await nessi.structured({ provider, input: "Test", output: z.object({ answer: z.string() }) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StructuredOutputError);
    expect(structuredProviderFailure(caught)).toBe(failure);
  });

  test("only unwraps provider failure codes with an own cause", () => {
    const failure = new Error("Provider failure");
    expect(structuredProviderFailure(new StructuredOutputError("Aborted", "aborted", { cause: failure }))).toBe(failure);
    for (const error of [
      new StructuredOutputError("Invalid output", "invalid_output", { cause: failure }),
      new StructuredOutputError("Loop failed", "loop_failed"),
      new StructuredOutputError("Loop failed", "loop_failed", Object.create({ cause: failure })),
      failure,
    ]) {
      expect(structuredProviderFailure(error)).toBe(error);
    }
  });
});

for (const [type, reasoningEffort] of [
  ["openai", "low"],
  ["gemini", "none"],
  ["anthropic", undefined],
] as const)
  test(`runAiStructured preserves ${type} task reasoning at the public task boundary`, async () => {
    const context: TraceContext = { traceId: "trace", spanId: "span", traceparent: "parent" };
    const span = spyOn(trace, "withSpan").mockImplementation(
      async <T>(_params: Parameters<typeof trace.withSpan>[0], run: (ctx: TraceContext) => Promise<T> | T) => run(context),
    );
    const record = spyOn(trace, "record").mockResolvedValue(context);
    const ledger = spyOn(structuredRuns, "safelyRecordStructuredRun").mockResolvedValue(undefined);
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: false, tools: false, images: false, thinking: true, usage: true },
      async *stream(request) {
        requests.push(request);
        yield* streamAnswer({ message: { role: "assistant", content: [{ type: "text", text: '{"answer":"ok"}' }] }, finishReason: "stop" });
      },
    };
    const accounting = spyOn(quotaProvider, "inferenceProvider").mockReturnValue(provider);
    try {
      const result = await runAiStructured({
        task: "test",
        input: "Answer",
        output: z.object({ answer: z.string() }),
        resolveModel: async (request) => {
          expect(request).toEqual({ class: "balanced" });
          return {
            model: { id: "fixture" },
            provider,
            profile: {
              modelId: "fixture",
              providerId: "fixture",
              variantLabel: "Standard",
              description: "",
              icon: { kind: "provider" },
              showInPicker: true,
              id: "fixture",
              label: "Fixture",
              provider: type,
              model: "fixture",
              enabled: true,
              capabilities: [],
              dataBoundary: "hosted",
            },
          };
        },
      });
      expect(result.output).toEqual({ answer: "ok" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.reasoningEffort).toBe(reasoningEffort);
    } finally {
      accounting.mockRestore();
      ledger.mockRestore();
      record.mockRestore();
      span.mockRestore();
    }
  });
