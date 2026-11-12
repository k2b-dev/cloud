import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationComment } from "../../service/collaboration";
import { readApiError } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { reconcileComments } from "./mail-details-reconciliation";
import { createRetryToasts } from "./mail-feedback";

/**
 * The internal notes of the open conversation, as the timeline shows them: the newest page from the page data,
 * live updates merged by revision, earlier pages on request, and editing or deleting one note.
 */
export function createMailConversationNotes(props: {
  mailboxId: () => string;
  conversationId: () => string | null;
  comments: () => readonly ConversationComment[];
  cursor: () => string | null;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const retryToast = createRetryToasts();
  const [notes, setNotes] = createSignal<ConversationComment[]>(reconcileComments([], [...props.comments()]));
  const [cursor, setCursor] = createSignal(props.cursor());
  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
  const [earlierError, setEarlierError] = createSignal<string | null>(null);
  let extended = false;
  let request = 0;
  let disposed = false;

  createEffect(
    on(
      props.conversationId,
      () => {
        request++;
        extended = false;
        setLoadingEarlier(false);
        setEarlierError(null);
        editNote.abort();
        removeNote.abort();
        setNotes(reconcileComments([], [...props.comments()]));
        setCursor(props.cursor());
      },
      { defer: true },
    ),
  );
  // Live updates bring the newest page again; notes loaded before it and newer revisions stay.
  createEffect(
    on(
      props.comments,
      (incoming) => {
        const conversationId = props.conversationId();
        setNotes((current) =>
          reconcileComments(
            current.filter((note) => note.conversationId === conversationId),
            incoming.filter((note) => note.conversationId === conversationId),
          ),
        );
        if (!extended) setCursor(props.cursor());
      },
      { defer: true },
    ),
  );

  const loadEarlier = async (): Promise<void> => {
    const current = cursor();
    const conversationId = props.conversationId();
    if (!current || !conversationId || loadingEarlier()) return;
    const id = ++request;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments.$get({
        param: { mailboxId: props.mailboxId(), conversationId },
        query: { cursor: current, limit: "100", order: "newest" },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().loadCommentsFailed));
      const page = await response.json();
      if (id !== request || disposed) return;
      extended = true;
      setNotes((existing) => reconcileComments(existing, page.items));
      setCursor(page.nextCursor);
    } catch (error) {
      if (id === request && !disposed) setEarlierError(error instanceof Error ? error.message : t().loadCommentsFailed);
    } finally {
      if (id === request) setLoadingEarlier(false);
    }
  };

  type NoteEdit = { mailboxId: string; conversationId: string; note: ConversationComment; body: string };
  const editNote = mutations.create<ConversationComment, NoteEdit, { edit: NoteEdit }>({
    onBefore: (edit) => ({ edit }),
    mutation: async ({ mailboxId, conversationId, note, body }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments[":commentId"].$patch(
        { param: { mailboxId, conversationId, commentId: note.id }, json: { expectedRevision: note.revision, body } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().updateCommentFailed));
      return response.json();
    },
    onSuccess: (updated) => {
      setNotes((current) => reconcileComments(current, [updated]));
      announce(t().commentUpdated);
    },
    // The edit has closed, so Retry saves the captured text again instead of losing it.
    onError: (error, context) =>
      retryToast(error.message, { retryLabel: t().retry, retry: () => context && editNote.mutate(context.edit) }),
  });

  const removeNote = mutations.create<ConversationComment | null, ConversationComment>({
    mutation: async (note, { abortSignal }) => {
      const conversationId = props.conversationId();
      const confirmed = await prompts.confirm(t().deletedAuditTrail, {
        title: t().deleteCommentTitle,
        confirmText: t().deleteComment,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted || !conversationId || conversationId !== note.conversationId) return null;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments[":commentId"].$delete(
        { param: { mailboxId: props.mailboxId(), conversationId, commentId: note.id }, json: { expectedRevision: note.revision } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().deleteCommentFailed));
      return note;
    },
    // The note stays at its place as a quiet "Note deleted" line, as everyone else sees it after the next update.
    onSuccess: (note) => {
      if (!note) return;
      const now = new Date().toISOString();
      setNotes((current) =>
        current.map((item) => (item.id === note.id ? { ...item, body: null, deletedAt: now, revision: item.revision + 1 } : item)),
      );
      announce(t().commentDeleted);
    },
    onError: (error) => toast.error(error.message),
  });

  onCleanup(() => {
    disposed = true;
    editNote.abort();
    removeNote.abort();
  });

  return {
    notes,
    hasEarlier: () => cursor() !== null,
    loadingEarlier,
    earlierError,
    loadEarlier,
    save: (note: ConversationComment, body: string) => {
      const conversationId = props.conversationId();
      if (!conversationId) return Promise.resolve();
      return editNote.mutate({ mailboxId: props.mailboxId(), conversationId, note, body });
    },
    saving: () => editNote.loading(),
    remove: (note: ConversationComment) => void removeNote.mutate(note),
  };
}
