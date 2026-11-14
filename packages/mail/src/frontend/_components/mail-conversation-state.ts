import { prompts, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationCollaboration, MailAssignableUser } from "../../service/collaboration";
import type { ConversationReminder } from "../../service/reminders";
import { readApiError } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import {
  applyMailCollaborationPatch,
  createMailDetailUpdateQueue,
  type MailCollaborationPatch,
  queuedCollaborationPatch,
  queuedReminderDueAt,
} from "./mail-detail-update-queue";
import { reconcileCollaboration, reconcileReminder } from "./mail-details-reconciliation";

type Result = { kind: "collaboration"; value: ConversationCollaboration } | { kind: "reminder"; value: ConversationReminder };

/**
 * The open conversation's own state that the reader head changes in place: "Show later" and the personal reminder.
 * Changes show at once and are written one after another; a failure restores the confirmed state and refreshes.
 */
export function createMailConversationState(props: {
  mailboxId: () => string;
  conversationId: () => string | null;
  collaboration: () => ConversationCollaboration | null;
  reminder: () => ConversationReminder | null;
  assignableUsers: () => readonly MailAssignableUser[];
  onCollaborationChange: (state: ConversationCollaboration) => void;
  onReconcile: () => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const [state, setState] = createSignal(props.collaboration());
  const [reminderDueAt, setReminderDueAt] = createSignal<string | null>(null);
  let confirmedState = props.collaboration();
  let confirmedReminder = props.reminder();
  const pendingDue = () => (confirmedReminder?.state === "pending" ? confirmedReminder.dueAt : null);
  setReminderDueAt(pendingDue());

  const queue = createMailDetailUpdateQueue<Result>({
    run: async (operation, signal) => {
      const conversationId = props.conversationId();
      if (!conversationId) throw new DOMException("No conversation", "AbortError");
      const param = { mailboxId: props.mailboxId(), conversationId };
      if (operation.kind === "collaboration") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].collaboration.$patch(
          { param, json: { expectedRevision: confirmedState?.revision ?? 0, ...operation.patch } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().updateConversationFailed));
        return { kind: "collaboration", value: await response.json() };
      }
      if (operation.kind === "reminder") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$put(
          { param, json: { dueAt: operation.dueAt, expectedRevision: confirmedReminder?.revision ?? null } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().setReminderFailed));
        return { kind: "reminder", value: await response.json() };
      }
      if (operation.kind !== "cancel_reminder" || confirmedReminder?.state !== "pending") throw new Error(t().noPendingReminder);
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$delete(
        { param, json: { expectedRevision: confirmedReminder.revision } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().cancelReminderFailed));
      return { kind: "reminder", value: await response.json() };
    },
    onSuccess: (result, _operation, queued) => {
      if (result.kind === "collaboration") {
        confirmedState = confirmedState ? reconcileCollaboration(confirmedState, result.value) : result.value;
        setState(applyMailCollaborationPatch(confirmedState, queuedCollaborationPatch(queued), props.assignableUsers()));
        props.onCollaborationChange(confirmedState);
        return;
      }
      confirmedReminder = reconcileReminder(confirmedReminder, result.value);
      const pending = queuedReminderDueAt(queued);
      setReminderDueAt(pending.pending ? pending.dueAt : pendingDue());
    },
    onError: async (error) => {
      setState(confirmedState);
      setReminderDueAt(pendingDue());
      await prompts.error(error.message, { title: t().conversationChanged });
      await props.onReconcile();
    },
  });

  // Another conversation starts from its own confirmed state; a pending write of the previous one stops.
  createEffect(
    on(
      props.conversationId,
      () => {
        queue.reset();
        confirmedState = props.collaboration();
        confirmedReminder = props.reminder();
        setState(confirmedState);
        setReminderDueAt(pendingDue());
      },
      { defer: true },
    ),
  );
  // Live updates and the head's other actions (Done, Assign) arrive as new snapshots; queued changes stay on top.
  createEffect(
    on(props.collaboration, (incoming) => {
      if (!incoming || incoming.conversationId !== props.conversationId()) return;
      confirmedState = confirmedState ? reconcileCollaboration(confirmedState, incoming) : incoming;
      setState(applyMailCollaborationPatch(confirmedState, queuedCollaborationPatch(queue.pending()), props.assignableUsers()));
    }),
  );
  createEffect(
    on(props.reminder, (incoming) => {
      confirmedReminder = reconcileReminder(confirmedReminder, incoming);
      const pending = queuedReminderDueAt(queue.pending());
      setReminderDueAt(pending.pending ? pending.dueAt : pendingDue());
    }),
  );
  onCleanup(() => queue.reset());

  const update = (patch: MailCollaborationPatch) => {
    setState((current) => (current ? applyMailCollaborationPatch(current, patch, props.assignableUsers()) : current));
    queue.enqueue({ kind: "collaboration", patch });
  };

  return {
    state,
    reminderDueAt,
    snooze: (until: string | null) => update({ snoozedUntil: until }),
    setReminder: (dueAt: string | null) => {
      setReminderDueAt(dueAt);
      queue.enqueue(dueAt ? { kind: "reminder", dueAt } : { kind: "cancel_reminder" });
    },
  };
}
