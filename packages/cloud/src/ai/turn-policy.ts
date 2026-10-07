import type { Provider, Tool, ToolResolver } from "@k2b/nessi";
import type { AiToolBlockStatus } from "./protocol";
import { AiTurnFailure } from "./turn-failure";

/** Calls that only find or load other tools. */
const DISCOVERY_TOOL_NAMES = new Set(["search_tools", "list_apps", "load_tools"]);
/** Discovery calls in a row, without a completed working step, that earn a hint: three app lookups of search plus load. */
const DISCOVERY_STREAK_LIMIT = 6;
/** The last tenth of a turn's run time limit is kept for the answer. */
const FINAL_ANSWER_BUDGET_SHARE = 0.1;

export type AiTurnFinalReason = "tool_rounds" | "run_time" | "loop";
export type AiTurnHint = "repeated_failure" | "discovery_loop";
export type AiTurnPolicyDecision = { kind: "hint"; hints: AiTurnHint[] } | { kind: "final_answer"; reason: AiTurnFinalReason };

/** A finished tool call under the name the model called it by. */
export type AiTurnPolicyToolCall = { name: string; args?: unknown; status: AiToolBlockStatus; result?: unknown };

const FINAL_ANSWER_CAUSE: Record<AiTurnFinalReason, string> = {
  tool_rounds: "The configured tool-round budget has been reached, so no more tools are available in this turn.",
  run_time: "The run time limit of this turn is almost reached, so no more tools are available in this turn.",
  loop: "This turn kept repeating steps that made no progress, so no more tools are available in this turn.",
};

const FINAL_ANSWER_CLOSE: Record<AiTurnFinalReason, string> = {
  tool_rounds: "",
  run_time: " Say which parts are still open; the user can continue the task with a new message.",
  loop: " Say what blocked you and what the user can do about it.",
};

const finalAnswerPrompt = (reason: AiTurnFinalReason) =>
  `# Final response
${FINAL_ANSWER_CAUSE[reason]} Answer the user's request now with the best result supported by the evidence already gathered. State any material uncertainty or incomplete part clearly.${FINAL_ANSWER_CLOSE[reason]}`;

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** Names a hint may repeat: only tools the model was offered, never a name it made up. */
const offeredNames = (names: readonly string[], offered: ReadonlySet<string>) => {
  const known = names.filter((name) => offered.has(name));
  return listFormat.format(known.length < names.length ? [...known, "a tool that is not available"] : known);
};

const hintPrompt = (hints: { repeatedFailures: string[]; discoveryStreak: number | null }, offered: ReadonlySet<string>) =>
  [
    "# Turn check",
    hints.repeatedFailures.length > 0
      ? `Calls to ${offeredNames(hints.repeatedFailures, offered)} failed twice with the same input. Do not repeat them with that input. Change your approach, or tell the user what blocks you.`
      : undefined,
    hints.discoveryStreak !== null
      ? `You searched for or loaded tools ${hints.discoveryStreak} times in a row without completing another step. Stop searching. Use the tools you already have, load the ones a search found, or tell the user what is not available in this turn.`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");

/** A completed load_tools call that made at least one more tool callable. */
const loadedTools = ({ name, status, result }: AiTurnPolicyToolCall) =>
  name === "load_tools" &&
  status === "completed" &&
  typeof result === "object" &&
  result !== null &&
  "loaded" in result &&
  Array.isArray(result.loaded) &&
  result.loaded.length > 0;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const withPrompt = (systemPrompt: string | undefined, suffix: string | null) =>
  suffix ? `${systemPrompt ?? ""}\n\n${suffix}`.trim() : systemPrompt;

/**
 * Keeps a chat turn from ending without an answer (#530).
 *
 * The policy is checked before every model call:
 * - the same call (tool name and input) failing twice, or six discovery calls
 *   in a row without a completed working step, adds a one-time hint to the next
 *   model call;
 * - either pattern after its hint, a positive `maxToolRounds` that is used up,
 *   or the last tenth of the run time limit ends tool use: the next model call
 *   gets no tools and a prompt to answer with what the turn has. If that call
 *   still asks for tools, the turn fails instead of looping without them.
 *
 * Rejected approvals are user decisions, not failures, and loading tools a
 * search found does not continue a discovery loop. A steering message starts
 * the loop checks over. The deadline abort stays as the backstop when a single
 * model or tool call outlasts the reserve. Calls a resumed attempt already
 * finished seed the counts without a hint of their own; a hint the earlier
 * attempt gave is not remembered.
 */
export const applyAiTurnPolicy = (input: {
  provider: Provider;
  tools: Tool[] | ToolResolver;
  maxToolRounds?: number;
  issuedToolRounds: number;
  completedToolRounds: number;
  /** Epoch milliseconds when the run time limit ends; null without a limit. */
  deadline: number | null;
  runBudgetMs: number | null;
  /** Tool calls this turn finished before this attempt and after its last steering message, oldest first. */
  finishedToolCalls?: readonly AiTurnPolicyToolCall[];
  onDecision?: (decision: AiTurnPolicyDecision) => void;
  now?: () => number;
}): {
  provider: Provider;
  tools: ToolResolver;
  maxTurns?: number;
  noteToolRound: () => void;
  noteToolCall: (call: AiTurnPolicyToolCall) => void;
  noteSteering: () => void;
} => {
  const now = input.now ?? Date.now;
  const limit = Math.floor(input.maxToolRounds ?? 0);
  const issuedAtStart = Math.max(0, Math.floor(input.issuedToolRounds));
  let completed = Math.max(0, Math.floor(input.completedToolRounds));
  // nessi resolves the tools once more to finish a round an earlier attempt left open.
  let resumingRound = issuedAtStart > completed;
  const reserveMs = input.runBudgetMs && input.runBudgetMs > 0 ? input.runBudgetMs * FINAL_ANSWER_BUDGET_SHARE : 0;

  const failures = new Map<string, number>();
  let repeatedFailures = new Set<string>();
  let discoveryStreak = 0;
  // A discovery call since the last check that made no new tool callable.
  let discoveredSinceCheck = false;
  const hinted = new Set<AiTurnHint>();
  let finalReason: AiTurnFinalReason | null = null;
  let completedAtFinal = 0;
  let pendingHint: string | null = null;
  let offered = new Set<string>();

  const noteToolCall = (call: AiTurnPolicyToolCall) => {
    const { name, args, status } = call;
    if (status !== "completed" && status !== "failed") return;
    if (status === "failed") {
      const key = `${name}\u0000${canonicalJson(args)}`;
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count >= 2) repeatedFailures.add(name);
    }
    if (DISCOVERY_TOOL_NAMES.has(name)) {
      discoveryStreak += 1;
      if (!loadedTools(call)) discoveredSinceCheck = true;
    } else if (status === "completed") {
      discoveryStreak = 0;
    }
  };
  for (const call of input.finishedToolCalls ?? []) noteToolCall(call);
  repeatedFailures = new Set();
  discoveredSinceCheck = false;

  const reserveReached = () => input.deadline !== null && reserveMs > 0 && input.deadline - now() <= reserveMs;
  const endToolUse = (reason: AiTurnFinalReason) => {
    finalReason = reason;
    completedAtFinal = completed;
    pendingHint = null;
    input.onDecision?.({ kind: "final_answer", reason });
  };

  const check = () => {
    if (finalReason) return;
    if (limit > 0 && completed >= limit) endToolUse("tool_rounds");
    else if (reserveReached()) endToolUse("run_time");
    else {
      const triggered: AiTurnHint[] = [];
      if (repeatedFailures.size > 0) triggered.push("repeated_failure");
      if (discoveredSinceCheck && discoveryStreak >= DISCOVERY_STREAK_LIMIT) triggered.push("discovery_loop");
      if (triggered.some((hint) => hinted.has(hint))) endToolUse("loop");
      else if (triggered.length > 0) {
        for (const hint of triggered) hinted.add(hint);
        pendingHint = hintPrompt(
          {
            repeatedFailures: triggered.includes("repeated_failure") ? [...repeatedFailures] : [],
            discoveryStreak: triggered.includes("discovery_loop") ? discoveryStreak : null,
          },
          offered,
        );
        input.onDecision?.({ kind: "hint", hints: triggered });
      }
    }
    repeatedFailures = new Set();
    discoveredSinceCheck = false;
  };

  const tools: ToolResolver = async () => {
    if (resumingRound) resumingRound = false;
    else check();
    if (finalReason) {
      if (completed > completedAtFinal) throw new AiTurnFailure("step_limit", "The model did not produce a final answer without tools.");
      return [];
    }
    const resolved = typeof input.tools === "function" ? await input.tools() : input.tools;
    offered = new Set(resolved.map((tool) => tool.def.name));
    return resolved;
  };
  const provider: Provider = {
    name: input.provider.name,
    family: input.provider.family,
    model: input.provider.model,
    contextWindow: input.provider.contextWindow,
    capabilities: input.provider.capabilities,
    complete: (request) => input.provider.complete(request),
    stream: async function* (request) {
      // Compaction may run between the tool check and this call; the reserve still holds.
      if (!finalReason && reserveReached()) endToolUse("run_time");
      let overflowed = false;
      for await (const event of input.provider.stream({
        ...request,
        tools: finalReason ? [] : request.tools,
        systemPrompt: withPrompt(request.systemPrompt, finalReason ? finalAnswerPrompt(finalReason) : pendingHint),
      })) {
        if (event.type === "issue" && event.issue.kind === "provider_error" && event.issue.contextOverflow) overflowed = true;
        yield event;
      }
      // nessi compacts an overflowed request and sends it again; the hint goes with it.
      if (!overflowed) pendingHint = null;
    },
  };

  return {
    provider,
    tools,
    // Nessi checks this before provider calls. The extra round is the tool-free
    // synthesis call after the last allowed tool-using round.
    ...(limit > 0 ? { maxTurns: Math.max(1, limit - issuedAtStart + 1) } : {}),
    noteToolRound: () => {
      completed += 1;
    },
    noteToolCall,
    noteSteering: () => {
      // New user input: the loop checks start over, and a loop's final answer may use tools again.
      failures.clear();
      repeatedFailures = new Set();
      discoveryStreak = 0;
      discoveredSinceCheck = false;
      hinted.clear();
      pendingHint = null;
      finalReason = null;
    },
  };
};
