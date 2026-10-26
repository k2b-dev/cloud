import { expect, spyOn, test } from "bun:test";
import type { NessiIssue, Provider } from "@k2b/nessi";
import { z } from "zod";
import { type TraceContext, trace } from "../services/logging";
import { AiProviderError, withProviderErrors } from "./provider-errors";
import * as quota from "./quota-provider";
import { runAiStructured } from "./structured";
import * as ledger from "./structured-runs";

const realInferenceProvider = quota.inferenceProvider;

test("an adapter cannot impersonate a trusted dispatch admission error", async () => {
  const raw = Object.assign(new quota.AiProviderAdmissionError("FICTIONAL_PROVIDER_ERROR_CANARY"), {
    aiError: { code: "model_access_denied" },
  });
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: false },
    complete: async () => {
      throw raw;
    },
    async *stream() {
      throw raw;
    },
  };
  const safe = withProviderErrors(provider);
  for (const call of [() => safe.complete({ messages: [] }), () => Array.fromAsync(safe.stream({ messages: [] }))]) {
    const error = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).not.toBeInstanceOf(quota.AiProviderAdmissionError);
    expect(error).not.toHaveProperty("aiError");
    expect(JSON.stringify(error)).not.toContain("FICTIONAL_PROVIDER_ERROR_CANARY");
  }
});

for (const kind of ["provider-message", "provider-body", "schema"] as const)
  test(`structured error content: ${kind}`, async () => {
    const marker = "ERFUNDENE-RECHNUNG-4711 IBAN-DE89370400440532013000";
    const failure = new Error(
      `Fixture 422: ${JSON.stringify(
        kind === "provider-body"
          ? { detail: [{ loc: ["body", "messages"], msg: "Validation failed", input: marker }] }
          : { error: { message: `Rejected input: ${marker}` } },
      )}`,
    );
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
      complete: async () => {
        if (kind !== "schema") throw failure;
        return {
          message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ number: { invalid: marker } }) }] },
          finishReason: "stop",
        };
      },
      async *stream() {
        throw new Error("unused");
      },
    };
    const ctx: TraceContext = { traceId: "trace", spanId: "span", traceparent: "parent" };
    const span = spyOn(trace, "withSpan").mockImplementation(async (_params, run) => run(ctx));
    const record = spyOn(trace, "record").mockResolvedValue(ctx);
    const calls: unknown[] = [];
    const accounting = spyOn(quota, "inferenceProvider").mockImplementation((p, profile, context) =>
      realInferenceProvider(p, profile, context, context, {
        begin: async () => ({ id: "00000000-0000-4000-8000-000000000001", maxOutputTokens: 128 }),
        finish: async (...args) => {
          calls.push(args);
        },
        heartbeat: async () => {},
      }),
    );
    const stored = spyOn(ledger, "safelyRecordStructuredRun").mockResolvedValue(undefined);
    try {
      await expect(
        runAiStructured({
          task: "incoming-capture-probe",
          input: marker,
          output: z.object({ number: z.string().nullable() }),
          resolveModel: async () => ({
            provider: withProviderErrors(provider),
            profile: {
              id: "fixture",
              label: "Fixture",
              provider: "openai-compatible",
              model: "fixture",
              enabled: true,
              capabilities: [],
              dataBoundary: "private",
            },
          }),
        }),
      ).rejects.toThrow(kind === "schema" ? "Provider returned invalid structured output." : "AI provider request failed.");
      expect(stored).toHaveBeenCalledTimes(1);
      if (kind === "schema") expect(stored.mock.calls[0]?.[0].error).not.toContain(marker);
      else expect(stored.mock.calls[0]?.[0].error).not.toContain(marker);
      expect(JSON.stringify(calls)).not.toContain(marker);
      expect(stored.mock.calls[0]?.[0].status).toBe("failed");
    } finally {
      stored.mockRestore();
      accounting.mockRestore();
      record.mockRestore();
      span.mockRestore();
    }
  });

// Arbitrary thrown values are replaced, including nested errors and custom names/codes/stacks.
for (const mode of ["complete", "stream", "stream-start", "stream-close", "aborted"] as const)
  test(`provider boundary: ${mode}`, async () => {
    const marker = "FICTIONAL_PROVIDER_ERROR_CANARY";
    const raw = Object.assign(new Error(marker, { cause: { body: marker } }), { name: marker, code: marker, stack: marker });
    const controller = new AbortController();
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
      complete: async () => {
        throw raw;
      },
      async *stream() {
        if (mode === "stream-close") {
          try {
            yield { type: "block_delta", blockId: "text", delta: "ok" };
          } finally {
            throw raw;
          }
        }
        throw raw;
      },
    };
    if (mode === "stream-start")
      provider.stream = () => {
        throw raw;
      };
    if (mode === "aborted") controller.abort(raw);
    const safe = withProviderErrors(provider);
    let caught: unknown;
    try {
      if (mode === "complete" || mode === "aborted") await safe.complete({ messages: [], signal: controller.signal });
      else
        for await (const _event of safe.stream({ messages: [] })) {
          if (mode === "stream-close") break;
        }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AiProviderError);
    expect(JSON.stringify(caught)).not.toContain(marker);
    if (!(caught instanceof Error)) throw new Error("Expected fixed provider error");
    expect(caught.message).toBe(mode === "aborted" ? "AI provider request was canceled." : "AI provider request failed.");
    expect(caught.stack).not.toContain(marker);
    expect(caught.cause).toBeUndefined();
  });

test("stream issues discard content and preserve retry, overflow, and tool-repair signals", async () => {
  const marker = "FICTIONAL_PROVIDER_ISSUE_CANARY";
  const issues: NessiIssue[] = [
    { kind: "provider_error", message: marker, retryable: true, contextOverflow: true, overflowRatio: 1.5 },
    { kind: "timeout", scope: "provider_first_byte", message: marker, retryable: true },
    {
      kind: "malformed_tool_call",
      reason: "invalid_tool_arguments",
      message: marker,
      callId: marker,
      name: marker,
      argsText: marker,
      textDelta: marker,
    },
    { kind: "cancelled_tool_call", reason: "provider_error_before_tool_call", message: marker, callId: marker, name: marker },
    { kind: "runtime_error", message: marker, retryable: false },
  ];
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
    complete: async () => {
      throw new Error("Unused complete");
    },
    async *stream() {
      for (const issue of issues) yield { type: "issue", issue: { ...issue, privateBody: marker } };
    },
  };
  const events = await Array.fromAsync(withProviderErrors(provider).stream({ messages: [] }));
  expect(JSON.stringify(events)).not.toContain(marker);
  expect(events[0]).toMatchObject({ issue: { kind: "provider_error", retryable: true, contextOverflow: true, overflowRatio: 1.5 } });
  expect(events[1]).toMatchObject({ issue: { kind: "timeout", retryable: true, scope: "provider_first_byte" } });
  expect(events[2]).toMatchObject({ issue: { kind: "malformed_tool_call", reason: "invalid_tool_arguments" } });
  expect(events[3]).toMatchObject({ issue: { kind: "cancelled_tool_call" } });
});
