import { createSignal, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailConversationPreview } from "../../contracts";
import type { MailListItem } from "./mail-navigation";

/** Recently hovered conversations whose card opens again without a request. */
const CACHE_LIMIT = 50;

export type MailQuickLookState = { status: "loading" } | { status: "ready"; data: MailConversationPreview } | { status: "error" };

type QuickLookTarget = Pick<MailListItem, "conversationId" | "revision" | "latestMessageAt" | "messageCount">;

/** A conversation's card data stays valid until its revision, newest message, or message count changes. */
export const mailQuickLookKey = (item: QuickLookTarget): string | null =>
  item.conversationId ? `${item.conversationId}:${item.revision}:${item.latestMessageAt}:${item.messageCount}` : null;

/**
 * Loads quick look cards for one mailbox. The list starts a request once the
 * mouse rests on a row, so the card usually has its data when it opens, and
 * stops it when the pointer leaves before the answer unless the card is open
 * for that row. Answers stay in a small cache keyed by the conversation's last
 * change; while a newer version loads, the card keeps the previous answer.
 */
export const createMailQuickLookLoader = (mailboxId: () => string) => {
  const [states, setStates] = createSignal<ReadonlyMap<string, MailQuickLookState>>(new Map());
  const requests = new Map<string, AbortController>();

  const update = (key: string, state: MailQuickLookState | null) =>
    setStates((current) => {
      const next = new Map(current);
      next.delete(key);
      if (state) next.set(key, state);
      for (const oldest of next.keys()) {
        if (next.size <= CACHE_LIMIT) break;
        if (!requests.has(oldest)) next.delete(oldest);
      }
      return next;
    });
  /** An abort or failure never replaces an earlier answer for the same key. */
  const settle = (key: string, state: MailQuickLookState | null) => {
    if (untrack(states).get(key)?.status !== "ready") update(key, state);
  };

  const load = (item: QuickLookTarget) => {
    const key = mailQuickLookKey(item);
    if (!key || !item.conversationId || requests.has(key)) return;
    const current = untrack(states).get(key);
    // A body that was still synchronizing may have arrived since the last answer.
    if (current?.status === "ready" && current.data.latestMessage?.body !== "syncing") return;
    const controller = new AbortController();
    requests.set(key, controller);
    if (current?.status !== "ready") update(key, { status: "loading" });
    void apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].preview
      .$get({ param: { mailboxId: mailboxId(), conversationId: item.conversationId } }, { init: { signal: controller.signal } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Quick look failed with ${response.status}`);
        return response.json();
      })
      .then(
        (data) => {
          if (requests.get(key) === controller) update(key, { status: "ready", data });
        },
        () => {
          if (requests.get(key) === controller) settle(key, controller.signal.aborted ? null : { status: "error" });
        },
      )
      .finally(() => {
        if (requests.get(key) === controller) requests.delete(key);
      });
  };

  const cancel = (item: QuickLookTarget) => {
    const key = mailQuickLookKey(item);
    const controller = key ? requests.get(key) : undefined;
    if (!key || !controller) return;
    requests.delete(key);
    controller.abort();
    settle(key, null);
  };

  return {
    load,
    cancel,
    state: (item: QuickLookTarget): MailQuickLookState => {
      const key = mailQuickLookKey(item);
      const own = key ? states().get(key) : undefined;
      if (own && own.status !== "loading") return own;
      const prefix = `${item.conversationId}:`;
      const previous = [...states()].findLast(([candidate, state]) => candidate.startsWith(prefix) && state.status === "ready")?.[1];
      return previous ?? { status: "loading" };
    },
  };
};

export type MailQuickLookLoader = ReturnType<typeof createMailQuickLookLoader>;
