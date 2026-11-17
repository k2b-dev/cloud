import { type CompactFn, estimateTokens, type Message, type Provider, type ProviderRequest, type Tool } from "@k2b/nessi";
import { AiTurnInferenceLimit } from "./turn-failure";
import type { AiTurnPolicyToolCall } from "./turn-policy";
import type { AiAutomationTurnStop, AiChatTurnRunConfig, AiCodeAuthoringStop } from "./types";

/**
 * Authoring has no F7 attempt allowance: F7 covers AI invoked BY saved Code.
 * Coordinator-confirmed operational allocation (#3323): four 128k request
 * windows = 512k input per interactive turn. A representative request gets a
 * quarter-window (32k), hence 512k / 32k = 16 provider attempts, including
 * retries and compaction. Reserve half a window (64k) for unknown usage and
 * compaction admission. These are operational allocations, not model limits.
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

/** Allocation for a turn that a person did not start (automation, chat chain).
 * Measured on 16.11.2026 with the R1 default model: 20 morning briefings in
 * fresh chats used 101k input tokens (median), 173k (p95) and 178k (max) over
 * 6 (median) to 9 model calls; one call returned at most 2.8k and one turn at
 * most 5.1k output tokens. A one-sentence number post costs one call and reads
 * the chat history (57k before, 10k after compaction). The input and call
 * allowances cover every measured briefing; the output caps give twice the
 * measured maximum. Chat calls, provider retries and compaction share it.
 */
export const AUTOMATION_TURN_BUDGET = {
  inputTokens: 192_000,
  modelCalls: 12,
  /** Ceiling for a single model call, sent to the provider. */
  maxOutputTokens: 4096,
  /** Ceiling for all calls of the turn together. */
  outputTokens: 12_000,
  /** One representative call: reserved for an input estimate that undershoots on the last call. */
  reserveInputTokens: 32_000,
  /** Charged per attempt that reports no usage, when the model's context window is unknown. */
  unknownInputTokens: 64_000,
  /** Automatic turns compact a chat history above this size; person turns keep the model's fill threshold. */
  compactAboveTokens: 32_000,
} as const;

/** Missing triggers retain legacy/person behavior; review revisions use authoring's allocation. */
export const isAutomaticAiChatTurn = (config: Pick<AiChatTurnRunConfig, "turnTrigger" | "codeReview">): boolean =>
  !config.codeReview && config.turnTrigger !== undefined && config.turnTrigger.kind !== "person";

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
  /** Only an explicit non-person trigger uses the automatic allocation. */
  nonPerson?: boolean;
  /** Priced Code uses the model window for attempts with unknown input usage. */
  inputTokenCeiling?: number;
  onStop?: (reason: "model_calls" | "input_tokens" | "output_tokens" | "repeated_error") => void;
}) {
  let authoring = input.selected;
  const active = () => input.nonPerson || authoring;
  const allocation = input.nonPerson ? AUTOMATION_TURN_BUDGET : CODE_AUTHORING_TURN_BUDGET;
  let stopped: AiCodeAuthoringStop | null = null;
  let automationStop: AiAutomationTurnStop | null = null;
  const receipts = new Map<string | number, AiTurnPolicyToolCall>();
  const progress = () => {
    let completedSteps = 0;
    const drafts = new Map<string, { checked: boolean; tested: boolean; submitted: boolean }>();
    for (const call of receipts.values()) {
      const result = record(call.result);
      const args = record(call.args);
      const config = record(result?.config);
      const summary = record(result?.draft);
      const codeId = args?.codeId ?? config?.codeId ?? summary?.codeId;
      const successful =
        call.status === "completed" && Boolean(result) && !result?.error && result?.ok !== false && record(result?.result)?.ok !== false;
      if (successful && authoringNames.has(call.name)) completedSteps++;
      const saved = successful && (summary || (config && record(result?.files)));
      // These operations require the conversation's persisted draft before producing
      // a domain result. They also establish its existence on a continuation turn.
      const draftOperation = ["code_check", "code_test", "code_simulate", "code_submit"].includes(call.name);
      const domainResult =
        call.status === "completed" &&
        Boolean(result) &&
        !record(result?.error) &&
        (call.name === "code_check"
          ? Boolean(record(result?.result))
          : call.name === "code_submit"
            ? Boolean(record(result?.submission))
            : typeof result?.ok === "boolean");
      const confirmedEdit =
        (successful && ["code_init", "code_pull", "code_write"].includes(call.name)) ||
        (draftOperation && domainResult && (args?.files !== undefined || args?.tests !== undefined || args?.entry !== undefined));
      if (typeof codeId !== "string") continue;
      if (saved || confirmedEdit || (draftOperation && domainResult && !drafts.has(codeId)))
        drafts.set(codeId, { checked: false, tested: false, submitted: false });
      const draft = drafts.get(codeId);
      if (draft && call.name === "code_check") draft.checked = successful && record(result?.result)?.ok === true;
      if (draft && ["code_test", "code_simulate"].includes(call.name)) draft.tested = successful && result?.ok === true;
      if (draft && call.name === "code_submit") draft.submitted = successful && Boolean(record(result?.submission));
    }
    return {
      completedSteps,
      drafts: drafts.size,
      unchecked: [...drafts.values()].filter((draft) => !draft.submitted && !draft.checked).length,
      untested: [...drafts.values()].filter((draft) => !draft.submitted && !draft.tested).length,
      unsubmitted: [...drafts.values()].filter((draft) => !draft.submitted).length,
    };
  };
  let calls = input.priorCalls.calls;
  let inputTokens = input.priorCalls.inputTokens;
  const errors = new Map<string, number>();
  const seenCalls = new Set<string>();
  const noteToolCall = (call: AiTurnPolicyToolCall & { callId?: string }) => {
    if (call.status !== "completed" && call.status !== "failed") return;
    // Keep the final receipt, including an output-validation failure that
    // supersedes the wrapper's provisional success, for the stop snapshot.
    receipts.set(call.callId ?? receipts.size, call);
    if (call.callId && seenCalls.has(call.callId)) return;
    if (authoringNames.has(call.name) || (call.name === "load_skill" && record(call.result)?.name === "code-authoring")) authoring = true;
    if (!authoring) return;
    const keys = failureKeys(call);
    // Output validation follows the tool wrapper. A provisional success must
    // not hide a later failed result from nessi for that same call ID.
    if (keys.length && call.callId) seenCalls.add(call.callId);
    for (const key of keys) errors.set(key, (errors.get(key) ?? 0) + 1);
  };
  for (const call of input.finishedToolCalls) noteToolCall(call);
  const stopReason = (estimate: number) =>
    authoring && [...errors.values()].some((count) => count > CODE_AUTHORING_TURN_BUDGET.identicalErrorRetries)
      ? "repeated_error"
      : calls >= allocation.modelCalls
        ? "model_calls"
        : inputTokens + estimate > allocation.inputTokens
          ? "input_tokens"
          : null;
  return {
    noteToolCall,
    stopped: () => stopped,
    automationStopped: () => automationStop,
    // Compaction's source is bounded to 60k characters; a half-window reserves
    // room for that source, its instructions, and the next chat admission.
    // Never let a locally generated stop become a persisted conversation summary.
    compact:
      (compact: CompactFn): CompactFn =>
      (context) => {
        if (active() && stopReason(allocation.unknownInputTokens)) return null;
        // Large-window models may reach the turn allowance before their normal
        // fill threshold. Compact history early so a later turn can continue.
        const threshold = input.nonPerson ? AUTOMATION_TURN_BUDGET.compactAboveTokens : allocation.unknownInputTokens;
        const largeHistory = active() && estimateTokens(context.entries.map((entry) => entry.message)) > threshold;
        return compact(largeHistory ? { ...context, fillRatio: Math.max(1, context.fillRatio ?? 0) } : context);
      },
    tools: (tools: Tool[]): Tool[] =>
      tools.map((tool) =>
        tool.kind !== "server" || !authoringNames.has(tool.def.name)
          ? tool
          : {
              ...tool,
              async execute(args, context) {
                authoring = true;
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
        const prepared = authoring ? { ...request, messages: projectCodeAuthoringContext(request.messages) } : request;
        const estimated = codeAuthoringInputTokens(prepared);
        const reason = active() ? stopReason(estimated) : null;
        if (reason) {
          // An oversized custom compaction prompt must never persist the stop as a summary.
          if (purpose === "compaction") return;
          if (input.nonPerson && !authoring && reason !== "repeated_error") automationStop = { reason };
          else stopped = { reason, ...progress() };
          input.onStop?.(reason);
          // A local terminal response costs no additional model call and cannot request more tools.
          // This boundary runs only after all tools of the previous response have settled.
          // Persist an empty terminal message with structured metadata. The host
          // renders its localized notice atomically; no streamed prose is replaced.
          const text = "";
          yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
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
        } catch (error) {
          if (!(error instanceof AiTurnInferenceLimit) || !input.nonPerson) throw error;
          if (purpose === "compaction") return;
          if (authoring) stopped = { reason: error.reason, ...progress() };
          else automationStop = { reason: error.reason };
          input.onStop?.(error.reason);
          yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "authoring-limit", index: 0, block: { type: "text", text: "" } };
        } finally {
          // Snapshots replace rather than add. Keep the estimate as a floor for missing/zero usage.
          inputTokens += Math.max(estimated, reported && reported > 0 ? reported : (input.inputTokenCeiling ?? estimated)) - estimated;
        }
      },
    }),
  };
}
