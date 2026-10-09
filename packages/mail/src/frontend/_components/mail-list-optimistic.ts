import type { MailListItem } from "../../service/workspace";

export type MailListOptimisticPatch = Partial<
  Pick<MailListItem, "unread" | "flagged" | "workStatus" | "assigneeUserIds" | "snoozedUntil" | "localTags" | "revision">
>;

export type MailListOptimisticField = keyof MailListOptimisticPatch;

export type PendingMailListState = MailListOptimisticPatch & {
  expiresAt: number;
};

const sameAssignees = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

const sameTagSelection = (left: MailListItem["localTags"], right: MailListItem["localTags"]): boolean => {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right.map((tag) => tag.id));
  return left.every((tag) => rightIds.has(tag.id));
};

/** The pending-state key of one message row, apart from the state its whole conversation is waiting for. */
export const mailListMessagePendingKey = (messageId: string): string => `message:${messageId}`;

/** The pending states that apply to a row: its conversation's, and in a message list its own message's. */
const pendingKeys = (item: MailListItem): string[] => [
  ...(item.conversationId ? [item.conversationId] : []),
  ...(item.selectionKind === "message" ? [mailListMessagePendingKey(item.id)] : []),
];

export const reconcileMailListOptimisticState = (
  items: MailListItem[],
  pending: ReadonlyMap<string, PendingMailListState>,
  now = Date.now(),
): { items: MailListItem[]; pending: Map<string, PendingMailListState> } => {
  const nextPending = new Map([...pending].filter(([, state]) => state.expiresAt > now));
  const applyPending = (item: MailListItem, key: string): MailListItem => {
    const state = nextPending.get(key);
    if (!state) return item;

    const confirmed = {
      unread: state.unread === undefined || state.unread === item.unread,
      flagged: state.flagged === undefined || state.flagged === item.flagged,
      workStatus: state.workStatus === undefined || state.workStatus === item.workStatus,
      assigneeUserIds: state.assigneeUserIds === undefined || sameAssignees(state.assigneeUserIds, item.assigneeUserIds),
      snoozedUntil: state.snoozedUntil === undefined || state.snoozedUntil === item.snoozedUntil,
      localTags: state.localTags === undefined || sameTagSelection(state.localTags, item.localTags),
      revision: state.revision === undefined || item.revision >= state.revision,
    } satisfies Record<MailListOptimisticField, boolean>;
    if (Object.values(confirmed).every(Boolean)) {
      nextPending.delete(key);
      return item;
    }

    const remaining: PendingMailListState = {
      expiresAt: state.expiresAt,
      ...(confirmed.unread ? {} : { unread: state.unread }),
      ...(confirmed.flagged ? {} : { flagged: state.flagged }),
      ...(confirmed.workStatus ? {} : { workStatus: state.workStatus }),
      ...(confirmed.assigneeUserIds ? {} : { assigneeUserIds: state.assigneeUserIds }),
      ...(confirmed.snoozedUntil ? {} : { snoozedUntil: state.snoozedUntil }),
      ...(confirmed.localTags ? {} : { localTags: state.localTags }),
      ...(confirmed.revision ? {} : { revision: state.revision }),
    };
    nextPending.set(key, remaining);
    return {
      ...item,
      ...(remaining.unread === undefined ? {} : { unread: remaining.unread }),
      ...(remaining.flagged === undefined ? {} : { flagged: remaining.flagged }),
      ...(remaining.workStatus === undefined ? {} : { workStatus: remaining.workStatus }),
      ...(remaining.assigneeUserIds === undefined ? {} : { assigneeUserIds: remaining.assigneeUserIds }),
      ...(remaining.snoozedUntil === undefined ? {} : { snoozedUntil: remaining.snoozedUntil }),
      ...(remaining.localTags === undefined ? {} : { localTags: remaining.localTags }),
      ...(remaining.revision === undefined ? {} : { revision: remaining.revision }),
    };
  };
  const nextItems = items.map((item) => pendingKeys(item).reduce(applyPending, item));

  return { items: nextItems, pending: nextPending };
};
