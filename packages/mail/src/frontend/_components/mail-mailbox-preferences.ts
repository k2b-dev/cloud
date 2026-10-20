import { toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { apiClient } from "../../api/client";
import { MAX_MAILBOX_PREFERENCES } from "../../mailbox-preference-limits";
import { mailOverviewMessages } from "../mail-overview-messages";
import { readApiError } from "./api-response";

/**
 * The person's pinned and hidden mailboxes, as the sidebar of every Mail page shows them. Pins and hidden mailboxes
 * apply on every device: a change shows at once and saves run in order. A failed save puts the mailbox back where the
 * server last confirmed it, so overlapping changes never leave a state the server does not have.
 */
export function createMailboxPreferences(initial: { pinnedMailboxIds: string[]; hiddenMailboxIds: string[] }) {
  const locale = useLocale();
  const messages = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const [pinnedMailboxIds, setPinnedMailboxIds] = createSignal(initial.pinnedMailboxIds);
  const [hiddenMailboxIds, setHiddenMailboxIds] = createSignal(initial.hiddenMailboxIds);
  const confirmed = { pinned: initial.pinnedMailboxIds, hidden: initial.hiddenMailboxIds };
  let saves = Promise.resolve();
  /** Puts the mailbox at `index`, or leaves it out with -1. */
  const place = (ids: string[], mailboxId: string, index: number) => {
    const others = ids.filter((id) => id !== mailboxId);
    return index === -1 ? others : [...others.slice(0, index), mailboxId, ...others.slice(index)];
  };
  // A new pin or hide is the newest; an existing one keeps its place.
  const withPreference = (ids: string[], mailboxId: string, value: boolean) =>
    ids.includes(mailboxId) === value ? ids : place(ids, mailboxId, value ? 0 : -1);
  /** Returns false when the list is full, so the row stays where it is. */
  const change = (mailboxId: string, preference: "pinned" | "hidden", value: boolean): boolean => {
    const [shown, setShown] = preference === "pinned" ? [pinnedMailboxIds, setPinnedMailboxIds] : [hiddenMailboxIds, setHiddenMailboxIds];
    // Focus leaves out every hidden mailbox in one request, so the lists stay within its limit.
    if (value && !shown().includes(mailboxId) && shown().length >= MAX_MAILBOX_PREFERENCES) {
      const count = MAX_MAILBOX_PREFERENCES.toLocaleString(locale());
      toast.error(preference === "pinned" ? messages().pinLimitReached({ count }) : messages().hideLimitReached({ count }));
      return false;
    }
    setShown((ids) => withPreference(ids, mailboxId, value));
    saves = saves.then(async () => {
      try {
        const response = await apiClient.mailboxes[":mailboxId"].preference.$patch({
          param: { mailboxId },
          json: preference === "pinned" ? { pinned: value } : { hidden: value },
        });
        if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveMailboxPreference));
        const saved = await response.json();
        confirmed[preference] = withPreference(confirmed[preference], mailboxId, saved[preference]);
      } catch (error) {
        const index = confirmed[preference].indexOf(mailboxId);
        setShown((ids) => place(ids, mailboxId, index));
        toast.error(error instanceof Error ? error.message : messages().failedSaveMailboxPreference);
      }
    });
    return true;
  };
  return {
    pinnedMailboxIds,
    hiddenMailboxIds,
    isPinned: (mailboxId: string) => pinnedMailboxIds().includes(mailboxId),
    isHidden: (mailboxId: string) => hiddenMailboxIds().includes(mailboxId),
    change,
  };
}

export type MailboxPreferences = ReturnType<typeof createMailboxPreferences>;

/** Pinned mailboxes first, in pin order; the others keep the server's order. */
export const orderMailboxes = <T extends { id: string }>(mailboxes: readonly T[], pinnedMailboxIds: readonly string[]): T[] =>
  [...mailboxes].sort((left, right) => {
    const leftIndex = pinnedMailboxIds.indexOf(left.id);
    const rightIndex = pinnedMailboxIds.indexOf(right.id);
    if (leftIndex === -1 && rightIndex === -1) return 0;
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
