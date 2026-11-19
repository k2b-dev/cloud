import type { AiTurnBlock } from "../protocol";
import type { AiMessageTimelineItem } from "../timeline";
import type { AiWakeup, AiWakeupEvent, AiWakeupInput } from "../wakeup-contracts";

/** How one alarm line reads: the fact, the alarm before it, and whether it is the alarm's newest line. */
export type AiWakeupLinePlan = {
  event: AiWakeupEvent;
  /** The same alarm in the line before, for "before 16:00" and "postponed". */
  previous?: AiWakeup;
  /** Only an alarm's newest line offers actions; older lines are history. */
  latest: boolean;
  /** The person deleted the alarm here: the line stays, struck through. */
  deleted: boolean;
};

const sameAlarm = (a: AiWakeup, b: AiWakeup) => a.at === b.at && a.cron === b.cron && a.endsAt === b.endsAt && a.note === b.note;

/**
 * One plan per alarm line of the chat, by timeline item. The person's deletion strikes the alarm's line through in
 * place instead of adding one; their "Undo" right after it sets the same alarm again and the line stands as before.
 */
export const planAiWakeupLines = (items: readonly AiMessageTimelineItem[]): Map<string, AiWakeupLinePlan> => {
  const plans = new Map<string, AiWakeupLinePlan>();
  const newest = new Map<string, AiWakeupLinePlan>();
  let undoable: AiWakeupLinePlan | null = null;
  for (const item of items) {
    const event = item.type === "wakeup" ? item.entry.meta?.wakeupEvent : undefined;
    if (!event || item.type !== "wakeup") {
      undoable = null;
      continue;
    }
    const before = newest.get(event.wakeup.id);
    const person = item.loopId === null;
    if (person && event.kind === "deleted" && before) {
      before.deleted = true;
      undoable = before;
      continue;
    }
    if (person && event.kind === "created" && undoable && sameAlarm(undoable.event.wakeup, event.wakeup)) {
      undoable.deleted = false;
      undoable.event = { ...undoable.event, wakeup: event.wakeup };
      newest.set(event.wakeup.id, undoable);
      undoable = null;
      continue;
    }
    undoable = null;
    if (before) before.latest = false;
    const plan: AiWakeupLinePlan = { event, ...(before ? { previous: before.event.wakeup } : {}), latest: true, deleted: false };
    plans.set(item.id, plan);
    newest.set(event.wakeup.id, plan);
  }
  return plans;
};

/**
 * One alarm line a host draws: a fact of the chat, or an alarm Gustav tried and could not set (`retried` once an alarm
 * with that note exists).
 */
export type AiWakeupLineInput =
  | { plan: AiWakeupLinePlan; failed?: undefined }
  | { plan?: undefined; failed: { input: AiWakeupInput; retried: boolean } };

/** The alarm Gustav tried to set in these blocks and could not, unless he set one after all. */
const failedWakeupInput = (blocks: readonly AiTurnBlock[]): AiWakeupInput | null => {
  let input: AiWakeupInput | null = null;
  for (const block of blocks) {
    if (block.kind !== "tool" || block.name !== "wakeup_create") continue;
    if (block.status === "completed") return null;
    const args = block.args;
    if (block.status !== "failed" || !args || typeof args !== "object") continue;
    const field = (key: string) => {
      const value: unknown = Reflect.get(args, key);
      return typeof value === "string" ? value : undefined;
    };
    const note = field("note");
    const timezone = field("timezone");
    if (note && timezone) input = { note, timezone, at: field("at"), cron: field("cron") ?? null, endsAt: field("endsAt") ?? null };
  }
  return input;
};

/**
 * Every alarm line of a chat's timeline by the id its row takes: a fact by its message, an alarm Gustav could not set
 * by `<turn item>:wakeup-failed`. Host and server read the same lines, so the server's first frame is final.
 */
export const collectAiWakeupLines = (timeline: readonly AiMessageTimelineItem[]): Map<string, AiWakeupLineInput> => {
  const lines = new Map<string, AiWakeupLineInput>();
  for (const [id, plan] of planAiWakeupLines(timeline)) lines.set(id, { plan });
  timeline.forEach((item, index) => {
    const input = item.type === "assistant" ? failedWakeupInput(item.blocks) : null;
    if (!input) return;
    const retried = timeline
      .slice(index + 1)
      .some((later) => later.type === "wakeup" && later.entry.meta?.wakeupEvent?.wakeup.note === input.note);
    lines.set(`${item.id}:wakeup-failed`, { failed: { input, retried } });
  });
  return lines;
};
