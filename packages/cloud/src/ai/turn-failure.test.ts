import { expect, test } from "bun:test";
import { defineTool, memoryStore, nessi, type Provider } from "@k2b/nessi";
import { openAICompatible } from "@k2b/nessi/ai";
import { z } from "zod";
import { aiTurnErrorCanContinue, aiTurnErrorText } from "./chat/turn-error";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "./inference-calls";
import { completeThroughStream } from "./provider";
import { AiQuotaError } from "./quotas";
import {
  AiTurnFailure,
  type AiTurnFailureReason,
  aiIssueDiagnostic,
  aiTurnErrorFromProviderIssue,
  aiTurnReasonFromThrown,
  rememberProviderErrors,
} from "./turn-failure";

test("a thrown error names the reason a person can act on, not its text", () => {
  expect(aiTurnReasonFromThrown(new AiTurnFailure("step_limit", "no final answer"))).toEqual({ error: { code: "step_limit" } });
  expect(aiTurnReasonFromThrown(new AiQuotaError("quota_exhausted", "Chat usage limit reached."))).toEqual({
    error: { code: "quota_exhausted" },
  });
  // Usage that could not be measured blocks the next turn like a used-up quota; another message would not help.
  expect(aiTurnReasonFromThrown(new AiQuotaError("quota_usage_unknown", "Chat usage could not be measured."))).toEqual({
    error: { code: "quota_exhausted" },
  });
  // Settings that deny the model or offer no usable one point to another model or the administrator, never to Continue.
  const denied = Object.assign(new Error("denied"), { aiError: { code: "model_policy_mismatch", message: "denied" } });
  expect(aiTurnReasonFromThrown(denied)).toEqual({ error: { code: "not_allowed" } });
  const missing = Object.assign(new Error("No model."), { aiError: { code: "ai_no_model", message: "No model." } });
  expect(aiTurnReasonFromThrown(missing)).toEqual({ error: { code: "not_allowed" } });
  // A background budget stop keeps Cloud's own explanation for task runs, as a blocked mandate does.
  const stopped = new AiBackgroundCostError();
  expect(aiTurnReasonFromThrown(stopped)).toEqual({ error: { code: "not_allowed" }, message: stopped.message });
  const insufficient = new AiBackgroundAdmissionError(false);
  expect(aiTurnReasonFromThrown(insufficient)).toEqual({ error: { code: "not_allowed" }, message: insufficient.message });
  expect(aiTurnReasonFromThrown(new Error("socket hang up"))).toEqual({ error: { code: "failed" } });
});

test("a model call's own issue ends the turn as an unavailable model or a full context; tool issues do not", () => {
  expect(aiTurnErrorFromProviderIssue({ kind: "provider_error", message: "502", retryable: true })).toEqual({ code: "model_unavailable" });
  expect(aiTurnErrorFromProviderIssue({ kind: "provider_error", message: "too long", retryable: false, contextOverflow: true })).toEqual({
    code: "context_full",
  });
  expect(aiTurnErrorFromProviderIssue({ kind: "timeout", scope: "provider_idle", message: "idle", retryable: true })).toEqual({
    code: "model_unavailable",
  });
  expect(aiTurnErrorFromProviderIssue({ kind: "timeout", scope: "tool", message: "slow", retryable: false })).toBeNull();
});

const throwing = (error: unknown): Provider => ({
  name: "fixture",
  family: "openai-compatible",
  model: "fixture",
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  complete: async () => {
    throw error;
  },
  async *stream() {
    throw error;
  },
});

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _event of stream) {
  }
};

test("an error a model call throws is remembered by its reason and still ends the call", async () => {
  const reasons: (AiTurnFailureReason | null)[] = [];
  const remember = (reason: AiTurnFailureReason | null) => {
    if (reason) reasons.push(reason);
  };
  const quota = rememberProviderErrors(throwing(new AiQuotaError("quota_exhausted", "Chat usage limit reached.")), remember);
  await expect(quota.complete({ messages: [] })).rejects.toThrow("Chat usage limit reached.");
  const reset = rememberProviderErrors(throwing(new Error("socket hang up")), remember);
  await expect(drain(reset.stream({ messages: [] }))).rejects.toThrow("socket hang up");
  // A stop is not a failure.
  const stopped = new AbortController();
  stopped.abort();
  await expect(reset.complete({ messages: [], signal: stopped.signal })).rejects.toThrow();
  expect(reasons).toEqual([{ error: { code: "quota_exhausted" } }, { error: { code: "model_unavailable" } }]);
});

test.each(["first_byte", "idle"] as const)(
  "a model call that stalls at %s through Cloud's provider times out as an unavailable model",
  async (stall) => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        if (stall === "first_byte") return new Promise<Response>(() => {});
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const reasons: (AiTurnFailureReason | null)[] = [];
      const provider = rememberProviderErrors(
        completeThroughStream(
          openAICompatible({
            name: "stalled",
            model: "mock",
            baseURL: `http://localhost:${server.port}/v1`,
            timeouts: { firstByteMs: 200, idleMs: 200 },
          }),
        ),
        (reason) => reasons.push(reason),
      );
      const startedAt = Date.now();
      // nessi reports an idle stall after streamed text as an unexpected end of the stream, not as a timeout.
      await expect(provider.complete({ messages: [] })).rejects.toThrow(
        stall === "first_byte" ? /first byte timeout/i : /ended unexpectedly/i,
      );
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(reasons).toEqual([null, { error: { code: "model_unavailable" } }]);
    } finally {
      server.stop(true);
    }
  },
);

test("a slow model that keeps making progress through Cloud's provider completes", async () => {
  const chunks = Array.from({ length: 10 }, (_, index) => `Part ${index}. `);
  const encoder = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    fetch() {
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index < chunks.length) {
              await Bun.sleep(100);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index++] } }] })}\n\n`));
              return;
            }
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const reasons: (AiTurnFailureReason | null)[] = [];
    const provider = rememberProviderErrors(
      completeThroughStream(
        openAICompatible({
          name: "progressing",
          model: "mock",
          baseURL: `http://localhost:${server.port}/v1`,
          // Chunks arrive every 100 ms, well inside each timeout; the whole answer takes longer than both together.
          timeouts: { firstByteMs: 400, idleMs: 400 },
        }),
      ),
      (reason) => reasons.push(reason),
    );
    const startedAt = Date.now();
    const result = await provider.complete({ messages: [] });
    expect(result.message.content).toEqual([{ type: "text", text: chunks.join("") }]);
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 3, output: 10 });
    expect(Date.now() - startedAt).toBeGreaterThan(800);
    expect(reasons).toEqual([null]);
  } finally {
    server.stop(true);
  }
});

test("each model call starts without a reason, and its own issue names one where the call runs", async () => {
  let reason: AiTurnFailureReason | null = { error: { code: "context_full" } };
  const calls: string[] = [];
  const provider = rememberProviderErrors(
    {
      ...throwing(null),
      async *stream() {
        // The reason of the call before is gone once this call runs.
        calls.push(reason ? "stale" : "clean");
        yield { type: "issue", issue: { kind: "provider_error", message: "upstream 502", retryable: false } };
      },
    },
    (remembered) => {
      reason = remembered;
    },
  );
  const atIssue: (AiTurnFailureReason | null)[] = [];
  for await (const event of provider.stream({ messages: [] })) if (event.type === "issue") atIssue.push(reason);
  expect(calls).toEqual(["clean"]);
  // Set before the issue leaves the call, so a reader that is still busy with older events cannot overwrite it.
  expect(atIssue).toEqual([{ error: { code: "model_unavailable" } }]);
});

test("the stored error says how to go on only when a new message can", () => {
  expect(aiTurnErrorText({ code: "model_unavailable" }, "en")).toBe(
    "The model service did not answer. The results so far are kept. Send a new message to continue.",
  );
  expect(aiTurnErrorText({ code: "time_limit", limitMinutes: 30 }, "de")).toBe(
    "Das Laufzeitlimit von 30 Minuten ist erreicht. Die bisherigen Ergebnisse bleiben erhalten. Mit einer neuen Nachricht geht es weiter.",
  );
  expect(aiTurnErrorText({ code: "context_full" }, "en")).toBe(
    "This chat is too long for the model. Start a new chat to continue; this one stays as it is.",
  );
});

test("a provider-stopped answer keeps its reason through nessi's loop-only issue", async () => {
  const provider = {
    ...throwing(null),
    async *stream() {
      yield { type: "usage" as const, finishReason: "error" as const, usage: { input: 8, output: 2, total: 10 } };
    },
    complete: async () => ({ message: { role: "assistant" as const, content: [] }, finishReason: "error" as const }),
  };
  const reasons: (AiTurnFailureReason | null)[] = [];
  const wrapped = rememberProviderErrors(provider, (reason) => reasons.push(reason));
  await drain(wrapped.stream({ messages: [] }));
  await wrapped.complete({ messages: [] });
  expect(reasons).toEqual([null, { error: { code: "provider_stopped" } }, null, { error: { code: "provider_stopped" } }]);
});

test("provider-stopped answers explain the stop in EN and DE and offer Continue", () => {
  expect(aiTurnErrorText({ code: "provider_stopped" }, "en")).toBe(
    "The model provider ended this answer early. The results so far are kept. Send a new message to continue.",
  );
  expect(aiTurnErrorText({ code: "provider_stopped" }, "de")).toBe(
    "Der KI-Anbieter hat diese Antwort vorzeitig beendet. Die bisherigen Ergebnisse bleiben erhalten. Mit einer neuen Nachricht geht es weiter.",
  );
});

test("nessi provider stops are classified before the loop-only issue and never execute their calls", async () => {
  const remembered: (AiTurnFailureReason | null)[] = [];
  const provider = rememberProviderErrors(
    {
      ...throwing(null),
      async *stream() {
        yield { type: "block_start", blockId: "call", index: 0, kind: "tool_call", callId: "call", name: "send" };
        yield { type: "block_end", blockId: "call", index: 0, block: { type: "tool_call", id: "call", name: "send", args: {} } };
        yield { type: "usage", usage: { input: 8, output: 2, total: 10 }, finishReason: "error" };
      },
    },
    (reason) => {
      remembered.push(reason);
    },
  );
  let ended = false;
  for await (const event of nessi({ provider, systemPrompt: "Test", store: memoryStore(), input: "Hello" })) {
    expect(event.type).not.toBe("tool_execution_start");
    if (event.type === "loop_end") {
      ended = true;
      expect(event.reason).toBe("error");
      expect(remembered.at(-1)).toEqual({ error: { code: "provider_stopped" } });
    }
  }
  expect(ended).toBe(true);
});

test("an unanswered failed step explains the failure in EN and DE and offers Continue", () => {
  expect(aiTurnErrorCanContinue({ code: "tool_failed" })).toBe(true);
  expect(aiTurnErrorText({ code: "tool_failed" }, "en")).toBe(
    "A step failed, and the model stopped without an answer. The results so far are kept. Send a new message to continue.",
  );
  expect(aiTurnErrorText({ code: "tool_failed" }, "de")).toBe(
    "Ein Schritt ist fehlgeschlagen, und das Modell hat danach nicht geantwortet. Die bisherigen Ergebnisse bleiben erhalten. Mit einer neuen Nachricht geht es weiter.",
  );
});

for (const kind of ["invalid-arguments", "unknown-tool"] as const)
  test(`loop diagnostics exclude ${kind} content`, async () => {
    const marker = "FICTIONAL_LOOP_DIAGNOSTIC_CANARY";
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
      complete: async () => {
        throw new Error("Unused complete");
      },
      async *stream() {
        yield {
          type: "block_end",
          blockId: "call",
          index: 0,
          block: { type: "tool_call", id: "call", name: kind === "unknown-tool" ? marker : "count", args: { count: marker } },
        };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
      },
    };
    const tools = [
      defineTool({ name: "count", description: "Count fictional entries", inputSchema: z.object({ count: z.number() }) }).server(
        async ({ count }) => count,
      ),
    ];
    const issues = [];
    for await (const event of nessi({
      provider,
      tools,
      systemPrompt: "Fictional test",
      input: "Count",
      store: memoryStore(),
      maxTurns: 1,
    })) {
      if (event.type === "issue") issues.push(event.issue);
    }
    expect(issues.some((issue) => issue.message.includes(marker))).toBe(true);
    expect(JSON.stringify(issues.map(aiIssueDiagnostic))).not.toContain(marker);
    expect(issues.map(aiIssueDiagnostic)).toContainEqual({ code: "tool_execution_error", message: "AI tool execution failed." });
  });
