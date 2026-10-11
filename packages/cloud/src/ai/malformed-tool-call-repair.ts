import type { NessiIssue, Provider, SessionStore, ToolCallBlock, ToolStreamIssue } from "@k2b/nessi";
import { AiTurnFailure } from "./turn-failure";
import type { AiStoredMessage } from "./types";

/** At most two automatic repairs per chat turn; user steering does not reset this budget. */
export const AI_MALFORMED_TOOL_CALL_REPAIR_ATTEMPTS = 2;

const excerpt = (text: string, maxChars: number): string => (text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`);

/** Never include argsText: code and other tool arguments can be very large. */
export const malformedToolCallMessage = (issue: ToolStreamIssue): string =>
  `The tool call${issue.name ? ` to ${excerpt(issue.name, 120)}` : ""} could not be used: ${excerpt(issue.message, 512)} (${issue.reason}).`;

const REPAIR_REQUEST = "Re-send the call with its exact tool name and complete, valid, properly escaped JSON arguments.";

const buildStoredMalformedToolCallRepairText = (name: string): string => `The tool call to ${name} could not be used. ${REPAIR_REQUEST}`;

export const buildMalformedToolCallRepairText = (issue: ToolStreamIssue): string => `${malformedToolCallMessage(issue)} ${REPAIR_REQUEST}`;

// The prefix lets resumed turns count repairs independently of ordinary tool calls. The id is 34 characters of [a-z0-9_],
// within OpenAI's 40- and Anthropic's 64-character limits; stricter providers (Mistral's nine alphanumeric characters)
// map ids at the transport boundary (see provider.ts).
export const newMalformedToolCallId = (): string => `malformed_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

export const isMalformedToolCallId = (id: string): boolean => /^malformed_[0-9a-f]{24}$/.test(id);

export const malformedToolCallName = (issue: ToolStreamIssue): string =>
  issue.name && /^[A-Za-z0-9_-]{1,64}$/.test(issue.name) ? issue.name : "unknown_tool";

// Partial responses (error/interrupted) count too: their stored error result requests the repair on resume, so each
// saved response with a malformed call spends one repair, as in the live run.
export const countMalformedToolCallRepairs = (messages: readonly Pick<AiStoredMessage, "message">[]): number =>
  messages.filter(
    ({ message }) =>
      message.role === "assistant" && message.content.some((block) => block.type === "tool_call" && isMalformedToolCallId(block.id)),
  ).length;

// Since 0.17.1, nessi also repairs malformed calls with its own user message and counter. Cloud's session store
// drops user messages nessi appends, and applying Cloud's repair through steering resets nessi's counter.
// Only Cloud's repair reaches the model and user; live executor integration tests pin this coupling.
export const createMalformedToolCallRepair = (previousAttempts: number) => {
  let attempts = previousAttempts;
  let lastIssue: ToolStreamIssue | undefined;
  // Malformed calls of the provider response in flight; pending marks a stored response that still awaits its repair.
  let issues: (ToolStreamIssue & { callId: string })[] = [];
  // A stored response beyond the budget means the run stopped before it could fail the turn.
  let pending = previousAttempts > AI_MALFORMED_TOOL_CALL_REPAIR_ATTEMPTS;
  return {
    startProviderTurn: () => {
      issues = [];
    },
    noteIssue: (issue: NessiIssue): NessiIssue => {
      if (issue.kind !== "malformed_tool_call") return issue;
      const rewritten = { ...issue, callId: newMalformedToolCallId() };
      issues.push(rewritten);
      lastIssue = rewritten;
      return rewritten;
    },
    /** Hands the response's malformed calls to the store once and marks the repair as due. */
    takeResponseIssues: () => {
      const taken = issues;
      issues = [];
      if (taken.length > 0) pending = true;
      return taken;
    },
    takeSteering: (): string | undefined => {
      if (!pending) return undefined;
      pending = false;
      if (attempts >= AI_MALFORMED_TOOL_CALL_REPAIR_ATTEMPTS || !lastIssue) {
        throw new AiTurnFailure(
          "failed",
          lastIssue
            ? malformedToolCallMessage(lastIssue)
            : "A stored response held a tool call that could not be used after the turn's repairs were spent.",
        );
      }
      attempts++;
      return buildMalformedToolCallRepairText(lastIssue);
    },
  };
};

export const withMalformedToolCallRepair = (provider: Provider, repair: ReturnType<typeof createMalformedToolCallRepair>): Provider => ({
  ...provider,
  stream: async function* (request) {
    repair.startProviderTurn();
    for await (const event of provider.stream(request)) {
      yield event.type === "issue" ? { ...event, issue: repair.noteIssue(event.issue) } : event;
    }
  },
});

export const withMalformedToolCallResults = (
  store: SessionStore,
  repair: ReturnType<typeof createMalformedToolCallRepair>,
): SessionStore => ({
  ...store,
  load: async () => {
    const entries = await store.load();
    const assistantIndex = entries.findLastIndex(({ message, kind }) => message.role === "assistant" && kind === "message");
    const assistant = entries[assistantIndex]?.message;
    const following = entries.slice(assistantIndex + 1);
    if (assistant?.role !== "assistant" || following.some(({ message }) => message.role === "user")) return entries;
    const resolved = new Set(following.flatMap(({ message }) => (message.role === "tool_result" ? [message.callId] : [])));
    const missing = assistant.content.filter(
      (block): block is ToolCallBlock => block.type === "tool_call" && isMalformedToolCallId(block.id) && !resolved.has(block.id),
    );
    if (missing.length === 0) return entries;
    for (const call of missing) {
      await store.append({
        role: "tool_result",
        callId: call.id,
        name: call.name,
        isError: true,
        result: buildStoredMalformedToolCallRepairText(call.name),
      });
    }
    return store.load();
  },
  append: async (message, opts) => {
    const issues = message.role === "assistant" && opts?.kind !== "summary" ? repair.takeResponseIssues() : [];
    if (message.role !== "assistant" || issues.length === 0) {
      await store.append(message, opts);
      return;
    }
    const calls: ToolCallBlock[] = issues.map((issue) => ({
      type: "tool_call",
      id: issue.callId,
      name: malformedToolCallName(issue),
      args: {},
    }));
    await store.append({ ...message, content: [...message.content, ...calls] }, opts);
    for (const issue of issues) {
      await store.append({
        role: "tool_result",
        callId: issue.callId,
        name: malformedToolCallName(issue),
        result: buildMalformedToolCallRepairText(issue),
        isError: true,
      });
    }
  },
});
