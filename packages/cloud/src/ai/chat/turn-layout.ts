import { type AiTurnBlock, isRenderableTurnBlock } from "../protocol";
import { hasCapabilityTable } from "./capability-result";
import { isCardToolName, isRecord, isSurveyToolName, isTextEditorToolName } from "./message-utils";

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

const failed = (block: ToolBlock) => block.isError === true || block.status === "failed";

/** A streamed status replaces the previous one only after its first sentence, so a reader never loses a sentence. */
export const hasCompleteSentence = (text: string): boolean => /[.!?…:;](?:\s|$)|\n/.test(text);

const resultTarget = (block: ToolBlock): string | null => {
  const args = isRecord(block.args) ? block.args : {};
  if (block.name === "present" && typeof args.path === "string") return `present:${args.path.trim()}`;
  if (block.name === "code_present" && typeof args.title === "string") return `code_present:${args.title.trim().toLowerCase()}`;
  return null;
};

const isResult = (block: ToolBlock, phase: AiTurnPhase, codePresentations: boolean): boolean => {
  if (failed(block) || block.status === "rejected" || block.status === "awaiting_approval") return false;
  const delivered = block.status === "completed" || (live(phase) && block.status === "running");
  if (block.name === "present" || isCardToolName(block.name)) return delivered;
  if (block.name === "code_present") return codePresentations && delivered;
  return hasCapabilityTable(block);
};

const actionState = (block: ToolBlock, phase: AiTurnPhase): AiTurnActionState | null => {
  if (block.status === "awaiting_approval") return "open";
  if (block.status === "rejected") return "rejected";
  if (isSurveyToolName(block.name) || isTextEditorToolName(block.name)) return failed(block) ? null : "interaction";
  if (block.name === "code_secret") return block.status === "awaiting_client" ? "interaction" : null;
  // Effects in Cloud and decided approvals stay visible as receipts, whether or not the model mentions them.
  const capabilityAction = block.presentation?.kind === "capability" && block.presentation.capabilityKind === "action";
  if (!capabilityAction && !block.approved) return null;
  if (block.status === "running" || block.status === "awaiting_client") return live(phase) ? "running" : "not_run";
  return failed(block) ? "failed" : "done";
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
    if (state) {
      actions.push({ id: block.id, block, state });
      continue;
    }
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

  const open = actions.filter((action) => action.state === "open" || action.state === "interaction");
  const waitingFor = open.some((action) => action.block.status === "awaiting_approval")
    ? "approval"
    : open.some((action) => action.block.status === "awaiting_client")
      ? "answer"
      : null;

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
