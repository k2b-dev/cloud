import { type AiTurnBlock, isRenderableTurnBlock } from "../protocol";
import type { AiStoredMessage } from "../types";
import { hasCapabilityTable } from "./capability-result";
import { isCardToolName, isChartToolName, isRecord, isSurveyToolName, isTextEditorToolName } from "./message-utils";
import { isFailedTool } from "./tool-groups";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type TextBlock = Extract<AiTurnBlock, { kind: "text" }>;

/**
 * How far a turn (or one segment of it) has come. A live turn is `running` or `waiting`; history is
 * `completed`, `stopped` (the user stopped it), or `failed`.
 */
export type AiTurnPhase = "running" | "waiting" | "completed" | "stopped" | "failed";

/** What a block in place 4 shows: an open decision, a running action, or a receipt for its outcome. */
export type AiTurnActionState = "open" | "interaction" | "running" | "done" | "rejected" | "failed" | "not_run";

export type AiTurnAction = { id: string; block: ToolBlock; state: AiTurnActionState };

export type AiTurnResult = { id: string; block: ToolBlock };

/**
 * The four fixed places of one turn. Live and history use the same function on the same blocks, so a
 * finished turn looks exactly like the live turn did, and a reload shows the same thing.
 */
export type AiTurnLayout = {
  /** Place 1: everything except the visible text, in the original order. Shown only when expanded. */
  work: AiTurnBlock[];
  /** Tool calls and compactions. */
  steps: number;
  /** A turn without tool calls or compactions has no work line, unless it was stopped or failed with folded text. */
  showWork: boolean;
  /** Place 2: delivered results in creation order. A result with the target of an earlier one replaces it at its place. */
  results: AiTurnResult[];
  /** Place 3: the newest text. Live it is a status; finished it is the final message. */
  text: TextBlock[];
  /** Place 4: effects in Cloud and decisions, open as a card or finished as a receipt. */
  actions: AiTurnAction[];
  /** The newest block, which names the current step of a live turn. */
  current: AiTurnBlock | null;
  /** What a waiting turn waits for. */
  waitingFor: "approval" | "answer" | null;
};

const live = (phase: AiTurnPhase) => phase === "running" || phase === "waiting";

const isInteraction = (name: string) => isSurveyToolName(name) || isTextEditorToolName(name) || name === "code_secret";

/**
 * A call that waits for the person: an approval, or an answer in a survey, an editor, or a secret prompt. Only this time
 * stops the work clock; a tool the browser runs by itself is work.
 */
export const waitsForUser = (block: AiTurnBlock): boolean =>
  block.kind === "tool" && (block.status === "awaiting_approval" || (block.status === "awaiting_client" && isInteraction(block.name)));

/** A streamed status replaces the previous one only after its first sentence, so a reader never loses a sentence. */
export const hasCompleteSentence = (text: string): boolean => /[.!?…:;](?:\s|$)|\n/.test(text);

const resultTarget = (block: ToolBlock): string | null => {
  const args = isRecord(block.args) ? block.args : {};
  if (block.name === "present" && typeof args.path === "string") return `present:${args.path.trim()}`;
  if (block.name === "code_present" && typeof args.title === "string") return `code_present:${args.title.trim().toLowerCase()}`;
  return null;
};

const isResult = (block: ToolBlock, phase: AiTurnPhase, codePresentations: boolean): boolean => {
  if (isFailedTool(block) || block.status === "rejected" || block.status === "awaiting_approval") return false;
  // A running delivery reserves its place once its arguments arrived: a new version of an earlier result must find the
  // earlier place before it takes one of its own.
  const delivered = block.status === "completed" || (live(phase) && block.status === "running" && block.args !== undefined);
  if (block.name === "present" || isCardToolName(block.name) || isChartToolName(block.name)) return delivered;
  if (block.name === "code_present") return codePresentations && delivered;
  return hasCapabilityTable(block);
};

const actionState = (block: ToolBlock, phase: AiTurnPhase): AiTurnActionState | null => {
  if (block.status === "awaiting_approval") return "open";
  if (block.status === "rejected") return "rejected";
  if (isSurveyToolName(block.name) || isTextEditorToolName(block.name)) return isFailedTool(block) ? null : "interaction";
  if (block.name === "code_secret") return block.status === "awaiting_client" ? "interaction" : null;
  // Effects in Cloud and approvals, decided or expired, stay visible as receipts, whether or not the model mentions them.
  const capabilityAction = block.presentation?.kind === "capability" && block.presentation.capabilityKind === "action";
  if (!capabilityAction && block.approved === undefined) return null;
  if (block.status === "running" || block.status === "awaiting_client") return live(phase) ? "running" : "not_run";
  return isFailedTool(block) ? "failed" : "done";
};

/**
 * Assign the blocks of one turn segment to the four places. Pure: the presentation renders live turns and
 * history through this one function.
 */
export function layoutAiTurn(input: readonly AiTurnBlock[], options: { phase: AiTurnPhase; codePresentations?: boolean }): AiTurnLayout {
  const blocks = input.filter(isRenderableTurnBlock);
  const tools = blocks.filter((block): block is ToolBlock => block.kind === "tool");
  const steps = tools.length + blocks.filter((block) => block.kind === "compaction").length;

  const results: AiTurnResult[] = [];
  const resultIndex = new Map<string, number>();
  const actions: AiTurnAction[] = [];
  for (const block of tools) {
    const state = actionState(block, options.phase);
    if (state) actions.push({ id: block.id, block, state });
    // An approved tool or a Cloud action can deliver a result too: it keeps its receipt and shows its result.
    if (!isResult(block, options.phase, options.codePresentations ?? false)) continue;
    const target = resultTarget(block);
    const index = target ? resultIndex.get(target) : undefined;
    if (index !== undefined) results[index] = { id: results[index]!.id, block };
    else {
      if (target) resultIndex.set(target, results.length);
      results.push({ id: block.id, block });
    }
  }

  const texts = blocks.filter((block): block is TextBlock => block.kind === "text");
  let text: TextBlock[] = [];
  if (options.phase !== "stopped" && options.phase !== "failed") {
    if (steps === 0) text = texts;
    else {
      const newest = texts.at(-1);
      const previous = texts.at(-2);
      const shown = newest && previous && live(options.phase) && !hasCompleteSentence(newest.text) ? previous : newest;
      text = shown ? [shown] : [];
    }
  }
  const visible = new Set(text);
  const work = blocks.filter((block) => !visible.has(block as TextBlock));

  const waits = tools.filter(waitsForUser);
  const waitingFor = waits.some((block) => block.status === "awaiting_approval") ? "approval" : waits.length > 0 ? "answer" : null;

  return {
    work,
    steps,
    showWork: steps > 0 || ((options.phase === "stopped" || options.phase === "failed") && work.length > 0),
    results,
    text,
    actions,
    current: blocks.at(-1) ?? null,
    waitingFor,
  };
}

/** The loop ending is authoritative; partial messages also carry their own failed or interrupted ending. */
export const storedPhase = (entries: readonly Pick<AiStoredMessage, "loopDoneReason" | "stopReason">[]): AiTurnPhase => {
  const reason = entries.findLast((entry) => entry.loopDoneReason)?.loopDoneReason;
  if (reason === "aborted") return "stopped";
  if (reason && reason !== "stop") return "failed";
  const stop = entries.findLast((entry) => entry.stopReason)?.stopReason;
  if (stop === "error") return "failed";
  if (stop === "interrupted" || stop === "aborted") return "stopped";
  return "completed";
};
