import { expect, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import { aiTurnErrorText } from "./chat/turn-error";
import { AiQuotaError } from "./quotas";
import { AiTurnFailure, aiTurnErrorFromProviderIssue, aiTurnErrorFromThrown, rememberProviderErrors } from "./turn-failure";
import type { AiTurnError } from "./types";

test("a thrown error names the reason a person can act on, not its text", () => {
  expect(aiTurnErrorFromThrown(new AiTurnFailure("step_limit", "no final answer"))).toEqual({ code: "step_limit" });
  expect(aiTurnErrorFromThrown(new AiQuotaError("quota_exhausted", "Chat usage limit reached."))).toEqual({ code: "quota_exhausted" });
  const denied = Object.assign(new Error("denied"), { aiError: { code: "model_access_denied", message: "denied" } });
  expect(aiTurnErrorFromThrown(denied)).toEqual({ code: "not_allowed" });
  const disabled = Object.assign(new Error("AI is disabled."), { aiError: { code: "ai_disabled", message: "AI is disabled." } });
  expect(aiTurnErrorFromThrown(disabled)).toEqual({ code: "model_unavailable" });
  expect(aiTurnErrorFromThrown(new Error("socket hang up"))).toEqual({ code: "failed" });
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

test("an error a model call throws is remembered by its reason and still ends the call", async () => {
  const reasons: AiTurnError[] = [];
  const remember = (reason: AiTurnError) => {
    reasons.push(reason);
  };
  const quota = rememberProviderErrors(throwing(new AiQuotaError("quota_exhausted", "Chat usage limit reached.")), remember);
  await expect(quota.complete({ messages: [] })).rejects.toThrow("Chat usage limit reached.");
  const reset = rememberProviderErrors(throwing(new Error("socket hang up")), remember);
  await expect(
    (async () => {
      for await (const _event of reset.stream({ messages: [] })) {
      }
    })(),
  ).rejects.toThrow("socket hang up");
  // A stop is not a failure.
  const stopped = new AbortController();
  stopped.abort();
  await expect(reset.complete({ messages: [], signal: stopped.signal })).rejects.toThrow();
  expect(reasons).toEqual([{ code: "quota_exhausted" }, { code: "model_unavailable" }]);
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
