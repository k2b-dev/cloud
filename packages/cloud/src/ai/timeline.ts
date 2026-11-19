import type { Message } from "@k2b/nessi";
import type { AiTurnBlock } from "./protocol";
import { buildBlocksFromMessages, steerAppliedBlockId } from "./protocol";
import type { AiStoredMessage } from "./types";

export type AiAssistantTimelineItem = {
  type: "assistant";
  id: string;
  loopId: string | null;
  entries: AiStoredMessage[];
  blocks: AiTurnBlock[];
  /** The entry whose message-actions row (copy/retry/fork) is shown. */
  actionEntry: AiStoredMessage | null;
  /**
   * Work time of the loop: wall time minus time spent waiting for user actions,
   * from the loop's durable timing. Without timing, the time from the user
   * message to the last persisted message.
   */
  workedMs: number;
};

export type AiMessageTimelineItem =
  | { type: "user"; id: string; entry: AiStoredMessage }
  | { type: "summary"; id: string; entry: AiStoredMessage }
  | { type: "code-decision"; id: string; entry: AiStoredMessage }
  | { type: "code-review-start"; id: string; entry: AiStoredMessage }
  /** A Cloud-authored alarm fact (`meta.wakeupEvent`), drawn as a line and never as an answer. */
  | {
      type: "wakeup";
      id: string;
      entry: AiStoredMessage;
      /** The turn that wrote it; null when the person or Cloud did. */
      loopId: string | null;
      /** The turn it follows, which may still run. */
      after: string | null;
    }
  | AiAssistantTimelineItem;

export const assistantVisibleTextFromMessage = (message: Message): string => {
  if (message.role !== "assistant") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
};

const isAssistantPart = (entry: AiStoredMessage): boolean =>
  entry.kind === "message" && (entry.message.role === "assistant" || entry.message.role === "tool_result");

const sameLoop = (entry: AiStoredMessage, loopId: string | null): boolean => (loopId ? entry.loopId === loopId : entry.loopId === null);
/** Each delivered background result is its own answer, also when deliveries follow each other. */
const sameBackgroundResult = (entry: AiStoredMessage, first: AiStoredMessage): boolean =>
  (entry.meta?.scheduledTask?.occurrenceId ?? null) === (first.meta?.scheduledTask?.occurrenceId ?? null);

const assistantActionEntry = (entries: AiStoredMessage[]): AiStoredMessage | null => {
  const assistantEntries = entries.filter((entry) => entry.kind === "message" && entry.message.role === "assistant");
  for (let i = assistantEntries.length - 1; i >= 0; i--) {
    const entry = assistantEntries[i]!;
    if (entry.loopAggregate || assistantVisibleTextFromMessage(entry.message)) return entry;
  }
  return assistantEntries.at(-1) ?? null;
};

/**
 * Group stored messages into render items: user bubbles, summary rows, and
 * assistant response groups (one per loop). Assistant groups carry a unified
 * AiTurnBlock list, identical in shape to a live turn's blocks.
 */
const timestampMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * An alarm fact a running turn wrote (Gustav's tool) is stored between that turn's messages, without its loop. It
 * stands after the turn's last message, where the turn ends, and never splits the turn's answer. A fact after a turn
 * ended stays where it is. `inLoop` names the turn a fact belongs to; `after` the turn it follows.
 */
const placeWakeupFacts = (
  messages: AiStoredMessage[],
  inLoop: Map<AiStoredMessage, string>,
  after: Map<AiStoredMessage, string>,
): AiStoredMessage[] => {
  const placed: AiStoredMessage[] = [];
  let held: AiStoredMessage[] = [];
  let loopId: string | null = null;
  for (const entry of messages) {
    if (entry.meta?.wakeupEvent) {
      if (!loopId) placed.push(entry);
      else {
        held.push(entry);
        after.set(entry, loopId);
      }
      continue;
    }
    if (held.length) {
      // The turn goes on after the fact: it belongs to that turn and moves to its end.
      if (loopId && entry.loopId === loopId) for (const fact of held) inLoop.set(fact, loopId);
      else {
        placed.push(...held);
        held = [];
      }
    }
    placed.push(entry);
    loopId = entry.loopId;
  }
  return held.length ? [...placed, ...held] : placed;
};

export const buildAiMessageTimeline = (stored: AiStoredMessage[]): AiMessageTimelineItem[] => {
  const inLoop = new Map<AiStoredMessage, string>();
  const after = new Map<AiStoredMessage, string>();
  const messages = stored.some((entry) => entry.meta?.wakeupEvent) ? placeWakeupFacts(stored, inLoop, after) : stored;
  const items: AiMessageTimelineItem[] = [];
  let lastUserEntry: AiStoredMessage | null = null;
  let pendingSteers: Array<{ loopId: string | null; steerId: string }> = [];

  const flushPendingSteers = () => {
    for (const steer of pendingSteers) {
      items.push({
        type: "assistant",
        id: `steer-marker-${steer.steerId}`,
        loopId: steer.loopId,
        entries: [],
        blocks: [{ id: steerAppliedBlockId(steer.steerId), kind: "steer_applied", steerId: steer.steerId }],
        actionEntry: null,
        workedMs: 0,
      });
    }
    pendingSteers = [];
  };

  for (let index = 0; index < messages.length; ) {
    const entry = messages[index]!;

    if (entry.meta?.codeDecision || entry.meta?.codeReviewStart) {
      flushPendingSteers();
      if (entry.meta.codeReviewStart) lastUserEntry = entry;
      items.push({ type: entry.meta.codeDecision ? "code-decision" : "code-review-start", id: entry.id, entry });
      index += 1;
      continue;
    }

    if (entry.meta?.wakeupEvent) {
      flushPendingSteers();
      items.push({ type: "wakeup", id: entry.id, entry, loopId: inLoop.get(entry) ?? null, after: after.get(entry) ?? null });
      index += 1;
      continue;
    }

    if (entry.kind === "summary") {
      flushPendingSteers();
      items.push({ type: "summary", id: entry.id, entry });
      index += 1;
      continue;
    }
    if (entry.message.role === "user") {
      if (!entry.meta?.steerId) flushPendingSteers();
      if (pendingSteers.some((steer) => steer.loopId !== entry.loopId)) flushPendingSteers();
      lastUserEntry = entry;
      items.push({ type: "user", id: entry.id, entry });
      if (entry.meta?.steerId) pendingSteers.push({ loopId: entry.loopId, steerId: entry.meta.steerId });
      index += 1;
      continue;
    }

    // Assistant response group: this assistant message plus following same-loop parts.
    const loopId = entry.loopId;
    if (pendingSteers.some((steer) => steer.loopId !== loopId)) flushPendingSteers();
    const steerBlocks = pendingSteers.map((steer) => ({
      id: steerAppliedBlockId(steer.steerId),
      kind: "steer_applied" as const,
      steerId: steer.steerId,
    }));
    pendingSteers = [];
    const entries = [entry];
    index += 1;
    while (
      index < messages.length &&
      isAssistantPart(messages[index]!) &&
      !messages[index]!.meta?.codeDecision &&
      !messages[index]!.meta?.wakeupEvent &&
      sameLoop(messages[index]!, loopId) &&
      (loopId !== null || sameBackgroundResult(messages[index]!, entry))
    ) {
      entries.push(messages[index]!);
      index += 1;
    }

    // Durable timestamps span all executor resumes, including tool/client waits.
    const startedAt =
      loopId && lastUserEntry?.loopId === loopId ? timestampMs(lastUserEntry.createdAt) : timestampMs(entries[0]?.createdAt);
    const finishedAt = timestampMs(entries.at(-1)?.createdAt);
    const timing = entries.findLast((stored) => stored.loopAggregate?.timing)?.loopAggregate?.timing;
    const workedMs = timing
      ? Math.max(0, timing.wallMs - timing.actionWaitMs)
      : startedAt !== null && finishedAt !== null
        ? Math.max(0, finishedAt - startedAt)
        : 0;

    const blocks = [
      ...steerBlocks,
      ...buildBlocksFromMessages(
        entries.map((stored) => ({ seq: stored.seq, message: stored.message, meta: stored.meta, createdAt: stored.createdAt })),
      ),
    ];
    items.push({
      type: "assistant",
      id: loopId ? `assistant-loop-${loopId}-${entry.id}` : `assistant-legacy-${entry.id}`,
      loopId,
      entries,
      blocks,
      actionEntry: assistantActionEntry(entries),
      workedMs,
    });
  }

  flushPendingSteers();
  return items;
};
