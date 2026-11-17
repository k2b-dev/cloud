import { type CompactFn, estimateTokens, type Message, type Provider, type ProviderRequest, type Tool } from "@k2b/nessi";
import { CORE_SETTINGS } from "../services/settings/core-settings";
import { PROVIDER_TIMEOUTS } from "./provider";
import { AiTurnFailure } from "./turn-failure";
import { AI_MODEL_REPAIR_TURNS, type AiTurnPolicyToolCall } from "./turn-policy";
import type { AiCodeAuthoringStop } from "./types";

const authoringModelCalls =
  ((CORE_SETTINGS["ai.turn_timeout_minutes"].default * 60_000) / PROVIDER_TIMEOUTS.firstByteMs) * (1 + AI_MODEL_REPAIR_TURNS);
/**
 * Authoring is paid through ordinary Assistant cost admission, not saved Code's
 * F7 budget. Only an effective finite cost allowance replaces the token cap.
 *
 * Loop backstop: the registry's default 30-minute turn contains 30 provider
 * first-byte timeout windows (PROVIDER_TIMEOUTS.firstByteMs = 60s). Allocate
 * one normal call plus the existing two malformed-call repair attempts per
 * window: 30 * 3 = 90 attempts, including retries and compaction. This is a
 * capacity allocation, not an assumption that every call takes one minute.
 * Without an effective cost allowance, use half-reference-window inputs (64k, the
 * existing unknown-usage/compaction reserve): 90 * 64k = 5.76M tokens.
 * Fully submitted drafts permit one additional tool-free closing attempt,
 * subject to cost admission or the remaining token allowance.
 */
export const CODE_AUTHORING_TURN_BUDGET = {
  inputTokens: authoringModelCalls * (128_000 / 2),
  unknownInputTokens: 128_000 / 2,
  modelCalls: authoringModelCalls,
  // Initial failure plus the same two repair attempts allowed for malformed model calls.
  identicalErrorRetries: AI_MODEL_REPAIR_TURNS,
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
  /** Cost admission enforces a finite allowance for the executed model and subject, without bypass. */
  billable?: boolean;
  onStop?: (reason: "model_calls" | "input_tokens" | "repeated_error") => void;
}) {
  let active = input.selected;
  let stopped: AiCodeAuthoringStop | null = null;
  let closingCallUsed = false;
  let closingAnswered = false;
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
        : !input.billable && inputTokens + estimate > CODE_AUTHORING_TURN_BUDGET.inputTokens
          ? "input_tokens"
          : null;
  return {
    noteToolCall,
    // Keep this at the accessor so every stop path, including inference admission,
    // preserves a receipt unless the one tool-free closing call actually answered.
    stopped: () => (stopped && !(stopped.drafts > 0 && stopped.unsubmitted === 0 && closingAnswered) ? stopped : null),
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
        let prepared = active ? { ...request, messages: projectCodeAuthoringContext(request.messages) } : request;
        let estimated = codeAuthoringInputTokens(prepared);
        const reason = active ? stopReason(estimated) : null;
        let closing = false;
        if (reason) {
          // An oversized custom compaction prompt must never persist the stop as a summary.
          if (purpose === "compaction") return;
          stopped = {
            reason,
            ...progress(),
          };
          input.onStop?.(reason);
          const finalRequest = {
            ...prepared,
            tools: [],
            systemPrompt: `${prepared.systemPrompt ?? ""}\nCode authoring has reached its ${reason} safety limit. Do not call any tools. Give one final answer: describe the submitted work and explicitly name any requested work that is unfinished or not yet started. Do not imply that unstarted work is complete.`,
          };
          const finalEstimate = codeAuthoringInputTokens(finalRequest);
          closing =
            !closingCallUsed &&
            stopped.drafts > 0 &&
            stopped.unsubmitted === 0 &&
            (input.billable || inputTokens + finalEstimate <= CODE_AUTHORING_TURN_BUDGET.inputTokens);
          if (closing) {
            closingCallUsed = true;
            prepared = finalRequest;
            estimated = finalEstimate;
          } else {
            // A local terminal response costs no additional model call and cannot request more tools.
            // This boundary runs only after all tools of the previous response have settled.
            // Persist an empty terminal message with structured metadata. The host
            // renders its localized notice atomically; no streamed prose is replaced.
            const text = "";
            yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
            yield { type: "block_end", blockId: "authoring-limit", index: 0, block: { type: "text", text } };
            return;
          }
        }
        calls++;
        // Reserve before dispatch, including retries and providers that omit usage.
        inputTokens += estimated;
        let reported: number | undefined;
        let answered = false;
        try {
          for await (const event of provider.stream(prepared)) {
            if (
              closing &&
              ((event.type === "block_start" && event.kind === "tool_call") ||
                (event.type === "block_end" && event.block.type === "tool_call"))
            )
              throw new AiTurnFailure("step_limit", "The model did not produce a final answer without tools.");
            if (closing && event.type === "issue" && event.issue.kind === "provider_error")
              throw new AiTurnFailure("model_unavailable", "The model could not produce the closing answer.");
            if (event.type === "block_end" && event.block.type === "text" && event.block.text.trim()) answered = true;
            if (event.type === "usage" && Number.isSafeInteger(event.usage.input) && event.usage.input >= 0) reported = event.usage.input;
            yield event;
          }
          if (closing) {
            closingAnswered = answered;
            if (!answered) {
              yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
              yield { type: "block_end", blockId: "authoring-limit", index: 0, block: { type: "text", text: "" } };
            }
          }
        } catch (error) {
          if (!closing || prepared.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          // Without a terminal assistant block, nessi closes an unfinished turn
          // as failed and the store never gets a message carrying the pause.
          yield { type: "block_start", blockId: "authoring-limit", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "authoring-limit", index: 0, block: { type: "text", text: "" } };
          return;
        } finally {
          // Snapshots replace rather than add. Keep the estimate as a floor for missing/zero usage.
          inputTokens += Math.max(estimated, reported ?? estimated) - estimated;
        }
      },
    }),
  };
}
