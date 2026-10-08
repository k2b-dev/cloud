import { expect, test } from "bun:test";
import { memoryStore, nessi, type Provider } from "@k2b/nessi";
import { aiTurnErrorText } from "./chat/turn-error";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "./inference-calls";
import { AiQuotaError } from "./quotas";
import {
  AiTurnFailure,
  type AiTurnFailureReason,
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
  const denied = Object.assign(new Error("denied"), { aiError: { code: "model_access_denied", message: "denied" } });
  expect(aiTurnReasonFromThrown(denied)).toEqual({ error: { code: "not_allowed" } });
  const missing = Object.assign(new Error("No API key."), { aiError: { code: "missing_provider_credential", message: "No API key." } });
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

test("provider-stopped answers explain the stop in EN and DE without offering Continue", () => {
  expect(aiTurnErrorText({ code: "provider_stopped" }, "en")).toBe(
    "The model provider stopped this answer. Adjust your request before trying again.",
  );
  expect(aiTurnErrorText({ code: "provider_stopped" }, "de")).toBe(
    "Der KI-Anbieter hat diese Antwort gestoppt. Passe deine Anfrage an, bevor du es erneut versuchst.",
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
