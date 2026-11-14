import { type CompactFn, estimateTokens, type Message, type Provider, type ProviderRequest, type Tool } from "@k2b/nessi";
import type { AiTurnPolicyToolCall } from "./turn-policy";

/**
 * Authoring has no F7 attempt allowance: F7 covers AI invoked BY saved Code.
 * Allocate four 128k request windows per interactive authoring turn. Reserve a
 * half-window for missing usage/compaction, and allow 16 quarter-window requests.
 * This independent safety budget also covers free/unpriced models; ordinary
 * Assistant cost admission still applies to every actual provider attempt.
 */
export const CODE_AUTHORING_TURN_BUDGET = {
  inputTokens: 4 * 128_000,
  unknownInputTokens: 128_000 / 2,
  modelCalls: (4 * 128_000) / (128_000 / 4),
  // Initial failure plus the same two repair attempts allowed for malformed model calls.
  identicalErrorRetries: 2,
} as const;

const authoringNames = new Set([
  "code_init",
  "code_pull",
  "code_sdk",
  "code_test",
  "code_simulate",
  "code_submit",
  "code_write",
  "code_read",
  "code_diff",
  "code_check",
]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;

/** Only discard SDK evidence after a later checker has verified the authored source. Full history stays intact. */
export function projectCodeAuthoringContext(messages: Message[]): Message[] {
  const calls = new Map<string, { name: string; codeId: unknown }>();
  const checked = new Set<unknown>();
  const projections = [...messages];
  for (const item of messages)
    if (item.role === "assistant")
      for (const part of item.content)
        if (part.type === "tool_call") calls.set(part.id, { name: part.name, codeId: record(part.args)?.codeId });
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant") continue;
    if (message.role !== "tool_result") continue;
    const call = calls.get(message.callId);
    if (typeof call?.codeId !== "string") continue;
    const result = record(message.result);
    if (message.name === "code_check" && record(result?.result)?.ok === true) checked.add(call.codeId);
    if (message.name === "code_sdk" && checked.has(call.codeId))
      projections[index] = {
        ...message,
        result: {
          version: result?.version,
          kind: result?.kind,
          apps: Array.isArray(result?.apps) ? result.apps.map((app) => (typeof app === "string" ? app : record(app)?.appId)) : [],
          note: "SDK reference omitted after a later successful code_check. The checked draft retains the source. Call code_sdk again if you need to change or inspect an API signature.",
        },
      };
  }
  return projections;
}

export const codeAuthoringInputTokens = (request: ProviderRequest): number =>
  estimateTokens(request.messages) +
  Math.ceil(
    ((request.systemPrompt?.length ?? 0) +
      JSON.stringify(request.tools ?? []).length +
      JSON.stringify(request.responseFormat ?? {}).length) /
      4,
  );

/** Stable runtime errors ignore fixture titles; diagnostics/assertions retain their actual identity. */
const failureKeys = (call: AiTurnPolicyToolCall): string[] => {
  if (!authoringNames.has(call.name)) return [];
  // nessi persists input-validation and execution failures as error text.
  if (call.status === "failed" && typeof call.result === "string")
    return [JSON.stringify([record(call.args)?.codeId, call.name, "transport", call.result])];
  const result = record(call.result);
  const outcome = call.name === "code_check" ? (record(result?.result) ?? result) : result;
  const envelope = record(outcome?.error);
  if (outcome?.ok !== false && !envelope && call.status !== "failed") return [];
  const identities = new Set<string>();
  const visit = (value: unknown, location: unknown[] = []) => {
    const item = record(value);
    if (!item || item.ok === true) return;
    const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics : [];
    for (const value of diagnostics) {
      const diagnostic = record(value);
      if (typeof diagnostic?.code === "string")
        identities.add(
          JSON.stringify(["diagnostic", diagnostic.code, diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message]),
        );
    }
    // A compile-error summary must not merge distinct diagnostics into one failure.
    const error = typeof item.error === "string" ? item.error : record(item.error)?.code;
    if (typeof error === "string" && !diagnostics.length) identities.add(JSON.stringify(["error", error]));
    if (Array.isArray(item.failures))
      for (const path of item.failures)
        if (typeof path === "string") identities.add(JSON.stringify(["assertion", ...location, item.entrypoint, path]));
    if (Array.isArray(item.cases)) for (const child of item.cases) visit(child, [record(child)?.file]);
    if (Array.isArray(item.runs)) for (const child of item.runs) visit(child, location);
  };
  visit(outcome);
  const codeId = record(call.args)?.codeId;
  const operation = ["code_test", "code_simulate"].includes(call.name) ? "test" : call.name;
  return [...identities].map((identity) => JSON.stringify([codeId, operation, identity]));
};

export function createCodeAuthoringTurnBudget(input: {
  priorCalls: { calls: number; inputTokens: number };
  finishedToolCalls: readonly AiTurnPolicyToolCall[];
  selected: boolean;
  locale: string;
  onStop?: (reason: "model_calls" | "input_tokens" | "repeated_error") => void;
}) {
  let active = input.selected;
  let calls = input.priorCalls.calls;
  let inputTokens = input.priorCalls.inputTokens;
  const errors = new Map<string, number>();
  const seenCalls = new Set<string>();
  const noteToolCall = (call: AiTurnPolicyToolCall & { callId?: string }) => {
    if (call.status !== "completed" && call.status !== "failed") return;
    if (call.callId && seenCalls.has(call.callId)) return;
    if (authoringNames.has(call.name) || (call.name === "load_skill" && record(call.result)?.name === "code-authoring")) active = true;
    if (!active) return;
    const keys = failureKeys(call);
    // Output validation follows the tool wrapper. A provisional success must
    // not hide a later failed result from nessi for that same call ID.
    if (keys.length && call.callId) seenCalls.add(call.callId);
    for (const key of keys) errors.set(key, (errors.get(key) ?? 0) + 1);
  };
  for (const call of input.finishedToolCalls) noteToolCall(call);
  const stopReason = (estimate: number) =>
    [...errors.values()].some((count) => count > CODE_AUTHORING_TURN_BUDGET.identicalErrorRetries)
      ? "repeated_error"
      : calls >= CODE_AUTHORING_TURN_BUDGET.modelCalls
        ? "model_calls"
        : inputTokens + estimate > CODE_AUTHORING_TURN_BUDGET.inputTokens
          ? "input_tokens"
          : null;
  return {
    noteToolCall,
    // Compaction's source is bounded to 60k characters; a half-window reserves
    // room for that source, its instructions, and the next chat admission.
    // Never let a locally generated stop become a persisted conversation summary.
    compact:
      (compact: CompactFn): CompactFn =>
      (context) => {
        if (active && stopReason(CODE_AUTHORING_TURN_BUDGET.unknownInputTokens)) return null;
        // Large-window models may reach the turn allowance before their normal
        // fill threshold. Compact history early so a later turn can continue.
        const largeHistory =
          active && estimateTokens(context.entries.map((entry) => entry.message)) > CODE_AUTHORING_TURN_BUDGET.unknownInputTokens;
        return compact(largeHistory ? { ...context, fillRatio: Math.max(1, context.fillRatio ?? 0) } : context);
      },
    tools: (tools: Tool[]): Tool[] =>
      tools.map((tool) =>
        tool.kind !== "server" || !authoringNames.has(tool.def.name)
          ? tool
          : {
              ...tool,
              async execute(args, context) {
                active = true;
                if ([...errors.values()].some((count) => count > CODE_AUTHORING_TURN_BUDGET.identicalErrorRetries))
                  return {
                    version: 1,
                    error: {
                      code: "code_authoring_turn_limit",
                      message: "Stop checking. The turn has exhausted its repair budget.",
                      details: null,
                    },
                  };
                const result = await tool.execute(args, context);
                noteToolCall({ name: tool.def.name, args, status: "completed", result, callId: context.callId });
                return result;
              },
            },
      ),
    wrap: (provider: Provider, purpose: "chat" | "compaction" = "chat"): Provider => ({
      ...provider,
      async *stream(request) {
        const prepared = active ? { ...request, messages: projectCodeAuthoringContext(request.messages) } : request;
        const estimated = codeAuthoringInputTokens(prepared);
        const reason = active ? stopReason(estimated) : null;
        if (reason) {
          // An oversized custom compaction prompt must never persist the stop as a summary.
          if (purpose === "compaction") return;
          input.onStop?.(reason);
          // A local terminal response costs no additional model call and cannot request more tools.
          // This boundary runs only after all tools of the previous response have settled.
          const text = input.locale.startsWith("de")
            ? "Ich halte hier an, damit sich die Arbeit nicht weiter im Kreis dreht oder zu groß wird. Die bisherigen Ergebnisse bleiben erhalten. Mit einer neuen Nachricht kannst du hier weiterarbeiten."
            : "I’m stopping here to keep this work from repeating or growing too large. The results so far are kept. You can continue here with a new message.";
          yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
          yield { type: "block_delta", blockId: "authoring-limit", delta: text };
          yield { type: "block_end", blockId: "authoring-limit", index: 0, block: { type: "text", text } };
          return;
        }
        calls++;
        // Reserve before dispatch, including retries and providers that omit usage.
        inputTokens += estimated;
        let reported: number | undefined;
        try {
          for await (const event of provider.stream(prepared)) {
            if (event.type === "usage" && Number.isSafeInteger(event.usage.input) && event.usage.input >= 0) reported = event.usage.input;
            yield event;
          }
        } finally {
          // Snapshots replace rather than add. Keep the estimate as a floor for missing/zero usage.
          inputTokens += Math.max(estimated, reported ?? estimated) - estimated;
        }
      },
    }),
  };
}
