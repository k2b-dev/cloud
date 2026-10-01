import { createSignal } from "solid-js";
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
 * Loads quick look cards for one mailbox. A request starts when the pointer
 * enters a row, so the card usually has its data when it opens, and stops when
 * the pointer leaves before the answer unless the card is open for that row.
 * Answers stay in a small cache keyed by the conversation's last change.
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

  const load = (item: QuickLookTarget) => {
    const key = mailQuickLookKey(item);
    const current = key ? states().get(key) : undefined;
    if (!key || !item.conversationId || current?.status === "ready" || requests.has(key)) return;
    const controller = new AbortController();
    requests.set(key, controller);
    update(key, { status: "loading" });
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
          if (requests.get(key) === controller) update(key, controller.signal.aborted ? null : { status: "error" });
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
    update(key, null);
  };

  return {
    load,
    cancel,
    state: (item: QuickLookTarget): MailQuickLookState => {
      const key = mailQuickLookKey(item);
      return (key && states().get(key)) || { status: "loading" };
    },
  };
};

export type MailQuickLookLoader = ReturnType<typeof createMailQuickLookLoader>;
