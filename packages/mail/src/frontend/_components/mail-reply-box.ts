import { dates } from "@k2b/stdlib";
import type { DraftIntent } from "../../contracts";
import type { MailWorkspaceMessage } from "../../service/workspace";

/**
 * The reply box's modes. The three mail modes write the conversation's one reply draft; "note" writes an internal
 * note through the comments API and never touches the draft or the send path.
 */
export type MailReplyMode = Exclude<DraftIntent, "new"> | "note";
export type MailReplyMailMode = Exclude<MailReplyMode, "note">;

export const isMailReplyMailMode = (mode: MailReplyMode | DraftIntent): mode is MailReplyMailMode =>
  mode === "reply" || mode === "reply_all" || mode === "forward";

type Delivery = NonNullable<MailWorkspaceMessage["delivery"]>;

/**
 * What a committed send means for the box. While the reply draft is scheduled, the box shows the time with its two
 * ways back. While it waits in the undo window or is on its way, the draft still occupies the conversation's one reply
 * place: the box looks empty and takes typing, but creates the next draft only once that send has left (`hold`).
 */
export type MailReplyBoxDelivery =
  | { kind: "scheduled"; submissionId: string; draftId: string; scheduledAt: string }
  | { kind: "hold"; submissionId: string; draftId: string; undoUntil: string | null };

export const replyBoxDelivery = (messages: readonly Pick<MailWorkspaceMessage, "delivery">[]): MailReplyBoxDelivery | null => {
  // The newest committed send decides; an older one has long left the box.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const delivery: Delivery | null | undefined = messages[index]!.delivery;
    if (!delivery) continue;
    if (delivery.state === "scheduled" && !delivery.lastErrorCode)
      return { kind: "scheduled", submissionId: delivery.submissionId, draftId: delivery.draftId, scheduledAt: delivery.scheduledAt };
    // A retry is still a committed send: it keeps the place like the undo window does.
    if (delivery.state === "undo_window" || delivery.state === "sending" || delivery.state === "scheduled")
      return { kind: "hold", submissionId: delivery.submissionId, draftId: delivery.draftId, undoUntil: delivery.undoUntil };
  }
  return null;
};

/**
 * The box's local text per conversation, in the signed-in person's Mail storage (cleared when they sign out):
 * `note` is unsaved note text (never in the draft), `pending` what was typed while another send held the reply place,
 * and `meanwhile` that text after Undo brought the earlier reply back.
 */
export type MailReplyBoxPart = "note" | "pending" | "meanwhile";
export const mailReplyBoxKey = (mailboxId: string, conversationId: string, part: MailReplyBoxPart): string =>
  `reply-box:${mailboxId}:${conversationId}:${part}`;

export const readMailReplyNote = (storage: Pick<Storage, "getItem"> | null, key: string): string => {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
};

/** Empty text removes the entry; a storage failure only loses the copy, never the text on screen. */
export const writeMailReplyNote = (storage: Pick<Storage, "setItem" | "removeItem"> | null, key: string, text: string): void => {
  try {
    if (text) storage?.setItem(key, text);
    else storage?.removeItem(key);
  } catch {
    /* The text stays in the box. */
  }
};

const SEND_LATER_HOUR = "08:00";

/**
 * "Tomorrow morning" and "Monday morning" at 08:00 in the person's time zone. On a Sunday, Monday morning is
 * tomorrow morning; on a Monday it is next week's.
 */
export const mailSendLaterPresets = (now: Date, timeZone: string): { tomorrow: string; monday: string } => {
  const wall = dates.instantToZonedInput(now, timeZone);
  const [year, month, day] = wall.slice(0, 10).split("-").map(Number) as [number, number, number];
  const at = (offsetDays: number) => {
    const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
    const iso = date.toISOString().slice(0, 10);
    return dates.zonedDateTimeToInstant(`${iso}T${SEND_LATER_HOUR}`, timeZone, { disambiguation: "compatible" });
  };
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const untilMonday = ((8 - weekday) % 7 || 7) as number;
  return { tomorrow: at(1), monday: at(untilMonday) };
};
