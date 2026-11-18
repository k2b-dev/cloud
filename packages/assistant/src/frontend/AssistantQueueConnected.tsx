import type { AiDraftContentPart } from "@k2b/cloud/ai";
import { prompts, useLocale } from "@k2b/ui";
import type { Accessor, Setter } from "solid-js";
import { assistantApi } from "../api/client";
import AssistantQueue, { type AssistantQueueEntry } from "./AssistantQueue";
import { assistantMessages } from "./messages";
import { queueMessages } from "./queue-messages";
import { sendQueuedEntryNow } from "./queue-send";

/**
 * What the chat lends its queue: the chat, its queued content, a fresh read, and the field. The three states live in
 * the chat, so a row that switches between its own line and the chip beside "Waiting for you" keeps them.
 */
export type AssistantQueueHost = {
  conversationId: Accessor<string | null>;
  content: (id: string) => readonly AiDraftContentPart[] | undefined;
  reload: () => Promise<unknown>;
  hasDraft: (conversationId: string) => boolean;
  putIntoField: (conversationId: string, content: readonly AiDraftContentPart[]) => void;
  fail: (message: string) => void;
  sendingId: Accessor<string | null>;
  setSendingId: Setter<string | null>;
  failedIds: Accessor<ReadonlySet<string>>;
  setFailedIds: Setter<ReadonlySet<string>>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
};

/**
 * The queue with its actions, loaded with it on first use so the chat's own bundle carries none of them. "Send now"
 * settles a lost answer through `sendQueuedEntryNow`; "Remove" and "Edit" read the queue again afterwards, and "Edit"
 * asks before it replaces a draft in the field.
 */
export default function AssistantQueueConnected(props: {
  host: AssistantQueueHost;
  entries: readonly AssistantQueueEntry[];
  layout: "line" | "chip";
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const texts = () => queueMessages.resolve([locale()]).t;
  const host = () => props.host;
  const ready = () => {
    const conversationId = host().conversationId();
    return conversationId && !host().sendingId() && !host().busy() ? conversationId : null;
  };
  const markFailed = (id: string, failed: boolean) =>
    host().setFailedIds((current) => {
      const next = new Set(current);
      if (failed) next.add(id);
      else next.delete(id);
      return next;
    });
  /** Runs a change of the queue that locks it meanwhile and reports a failure in the chat's status line. */
  const change = async (work: () => Promise<void>) => {
    host().setBusy(true);
    try {
      await work();
    } catch (error) {
      host().fail(error instanceof Error ? error.message : t().chatActionFailed);
    } finally {
      host().setBusy(false);
    }
  };

  const sendNow = async (entry: AssistantQueueEntry) => {
    const conversationId = ready();
    if (!conversationId) return;
    markFailed(entry.id, false);
    host().setSendingId(entry.id);
    try {
      const outcome = await sendQueuedEntryNow({
        send: () => assistantApi.sendQueuedMessageNow(conversationId, entry.id),
        receipt: () => assistantApi.queuedMessageSendReceipt(conversationId, entry.id),
        reload: host().reload,
      });
      markFailed(entry.id, outcome === "not-sent");
    } finally {
      host().setSendingId(null);
    }
  };
  const remove = async (entry: AssistantQueueEntry) => {
    const conversationId = ready();
    if (!conversationId) return;
    await change(async () => {
      await assistantApi.cancelQueuedMessage(conversationId, entry.id);
      markFailed(entry.id, false);
      await host().reload();
    });
  };
  /** "Edit" takes one's own entry out of the queue and puts it into the field. */
  const edit = async (entry: AssistantQueueEntry) => {
    const conversationId = ready();
    const content = host().content(entry.id);
    if (!conversationId || !content) return;
    if (
      host().hasDraft(conversationId) &&
      !(await prompts.confirm(texts().replaceDraft, { title: texts().edit, confirmText: texts().edit }))
    )
      return;
    await change(async () => {
      await assistantApi.cancelQueuedMessage(conversationId, entry.id);
      if (host().conversationId() === conversationId) host().putIntoField(conversationId, content);
      await host().reload();
    });
  };

  return (
    <AssistantQueue
      entries={props.entries}
      layout={props.layout}
      sendingId={host().sendingId()}
      failedIds={host().failedIds()}
      busy={host().busy()}
      onSendNow={(entry) => void sendNow(entry)}
      onEdit={(entry) => void edit(entry)}
      onRemove={(entry) => void remove(entry)}
    />
  );
}
