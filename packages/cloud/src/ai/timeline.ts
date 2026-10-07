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

export const buildAiMessageTimeline = (messages: AiStoredMessage[]): AiMessageTimelineItem[] => {
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
    while (index < messages.length && isAssistantPart(messages[index]!) && sameLoop(messages[index]!, loopId)) {
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
      ...buildBlocksFromMessages(entries.map((stored) => ({ seq: stored.seq, message: stored.message, meta: stored.meta }))),
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
