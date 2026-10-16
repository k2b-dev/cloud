import { CloudAvatar } from "@k2b/cloud/account/ui";
import { type DateContext, dates, type Paginated } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { announce, Button, Discussion, IconButton, MarkdownView, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicNoteComment } from "@/api/public-resources";
import { notebookWorkspaceMessages } from "../../messages";
import { readErrorMessage } from "../settings/utils";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { REVEAL_COMMENT_EVENT, type RevealCommentEventDetail } from "./events";

type Props = {
  notebookId: string;
  noteId: string;
  currentUserId: string;
  canWrite: boolean;
  initialCommentsPage?: Paginated<PublicNoteComment>;
  dateConfig: DateContext;
  /** Without a connection a new comment cannot be sent; the action stays in place, disabled, with the reason. */
  offline?: boolean;
};

const PER_PAGE = 30;
/** Comments shown before "n older": the newest few, so the panel's other sections stay in reach. */
const NEWEST = 3;
const sourceFor = (notebookId: string, noteId: string) => `${notebookId}:${noteId}`;
const parseSource = (source: string) => {
  const [notebookId, noteId] = source.split(":");
  if (!notebookId || !noteId) throw new Error("Invalid note comment source");
  return { notebookId, noteId };
};

export default function NoteCommentsSection(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const source = () => sourceFor(props.notebookId, props.noteId);
  const initialSource = sourceFor(props.notebookId, props.noteId);
  const emptyPage: Paginated<PublicNoteComment> = { items: [], page: 1, perPage: PER_PAGE, total: 0, hasNext: false };
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);

  const commentsQuery = query.createInfinite<string, Paginated<PublicNoteComment>, number, { cursor: string | null }>({
    source,
    ...(props.initialCommentsPage ? { initial: { source: initialSource, pages: [props.initialCommentsPage] } } : {}),
    loadPage: async (currentSource, { cursor, abortSignal }) => {
      const { notebookId, noteId } = parseSource(currentSource);
      const response = await apiClient[":id"].notes[":noteId"].comments.page.$get(
        {
          param: { id: notebookId, noteId },
          query: { page: String(cursor ?? 1), per_page: String(PER_PAGE) },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().loadCommentsFailed));
      return response.json();
    },
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
    subscribe: ({ invalidate }) => {
      const onWorkspaceEvent = (raw: Event) => {
        const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
        if (
          detail.event.type !== "note.comments.changed" ||
          detail.event.notebookId !== props.notebookId ||
          detail.event.noteId !== props.noteId
        ) {
          return;
        }
        detail.cover(invalidate({ cursor: detail.cursor }));
      };
      window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      return () => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    },
  });

  const commentsPage = createMemo(() => {
    const pages = commentsQuery.pages();
    const first = pages[0] ?? emptyPage;
    const last = pages.at(-1) ?? first;
    const seen = new Set<string>();
    const items = pages
      .flatMap((page) => page.items)
      .filter((comment) => {
        if (seen.has(comment.id)) return false;
        seen.add(comment.id);
        return true;
      })
      .reverse();
    return { ...last, items, total: Math.max(first.total, last.total) };
  });

  createEffect(() => {
    void source();
    setComposerOpen(false);
    setEditingId(null);
    setExpanded(false);
  });

  // The activity list links to a comment: unfold the list when it is older, then bring it into view.
  onMount(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<RevealCommentEventDetail>).detail;
      const index = commentsPage().items.findIndex((comment) => comment.id === detail?.commentId);
      if (index >= 0 && index < commentsPage().items.length - NEWEST) setExpanded(true);
      queueMicrotask(() => {
        const target =
          (detail?.commentId ? document.querySelector<HTMLElement>(`[data-note-comment="${CSS.escape(detail.commentId)}"]`) : null) ??
          document.querySelector<HTMLElement>("[data-note-comments]");
        target?.scrollIntoView({ block: "nearest" });
        target?.focus({ preventScroll: true });
      });
    };
    window.addEventListener(REVEAL_COMMENT_EVENT, reveal);
    onCleanup(() => window.removeEventListener(REVEAL_COMMENT_EVENT, reveal));
  });

  const exactTime = (value: string) => dates.formatDateTime(value, props.dateConfig);

  type CommentTarget = { notebookId: string; noteId: string };
  // The list shows a saved change only after the refresh, so a screen reader hears the outcome only then. When the
  // refresh fails, the error toast already says that the change was saved.
  const reconcile = (target: CommentTarget, outcome: string) => {
    if (source() !== sourceFor(target.notebookId, target.noteId)) return;
    void commentsQuery.invalidate({ cursor: null }).then(
      () => announce(outcome),
      () => toast.error(t().commentSavedReloadFailed),
    );
  };

  const createMutation = mutations.create<{ target: CommentTarget; comment: PublicNoteComment }, CommentTarget & { content: string }>({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient[":id"].notes[":noteId"].comments.$post(
        { param: { id: target.notebookId, noteId: target.noteId }, json: { content: target.content } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().addCommentFailed));
      return { target, comment: await response.json() };
    },
    // The new comment appears in the list and the composer closes, so a screen reader is told. A failure stays under
    // the composer, which keeps the draft.
    onSuccess: ({ target }) => {
      if (source() === sourceFor(target.notebookId, target.noteId)) setComposerOpen(false);
      reconcile(target, t().commentAdded);
    },
  });

  const updateMutation = mutations.create<
    { target: CommentTarget; comment: PublicNoteComment },
    CommentTarget & { commentId: string; content: string }
  >({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient[":id"].notes[":noteId"].comments[":commentId"].$patch(
        {
          param: { id: target.notebookId, noteId: target.noteId, commentId: target.commentId },
          json: { content: target.content },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().updateCommentFailed));
      return { target, comment: await response.json() };
    },
    // The comment shows its new text and the edit composer that had focus closes, so a screen reader is told. A failure
    // stays under the edit composer, which keeps the text.
    onSuccess: ({ target }) => {
      if (source() === sourceFor(target.notebookId, target.noteId)) setEditingId(null);
      reconcile(target, t().commentUpdated);
    },
  });

  const deleteMutation = mutations.create<CommentTarget, CommentTarget & { commentId: string }>({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient[":id"].notes[":noteId"].comments[":commentId"].$delete(
        { param: { id: target.notebookId, noteId: target.noteId, commentId: target.commentId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().deleteCommentFailed));
      return target;
    },
    // The comment leaves the list together with its delete button, which had focus, so a screen reader is told.
    onSuccess: (target) => reconcile(target, t().commentDeleted),
    onError: (error) => toast.error(error.message),
  });

  onCleanup(() => {
    createMutation.abort();
    updateMutation.abort();
    deleteMutation.abort();
  });

  const deleteComment = async (comment: PublicNoteComment) => {
    if (deleteConfirming() || deleteMutation.loading()) return;
    setDeleteConfirming(true);
    try {
      const confirmed = await prompts.confirm(t().deleteCommentConfirm, {
        title: t().deleteComment,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().delete,
        cancelText: t().cancel,
      });
      if (!confirmed) return;
      await deleteMutation.mutate({ notebookId: props.notebookId, noteId: props.noteId, commentId: comment.id });
    } finally {
      setDeleteConfirming(false);
    }
  };

  const composer = () => (
    <Show when={props.canWrite && composerOpen()}>
      <Discussion.Composer
        label={t().addComment}
        placeholder={t().commentPlaceholder}
        submitLabel={t().postComment}
        cancelLabel={t().cancel}
        onCancel={() => setComposerOpen(false)}
        lines={5}
        onSubmit={async (content) => {
          await createMutation.mutate({ notebookId: props.notebookId, noteId: props.noteId, content });
          const error = createMutation.error();
          if (error) throw error;
        }}
      />
    </Show>
  );

  return (
    <Show when={props.canWrite || commentsPage().total > 0}>
      <Discussion
        label={t().comments}
        icon="ti ti-message"
        count={commentsPage().total}
        data-note-comments=""
        tabIndex={-1}
        actions={
          props.canWrite ? (
            // Stays in the header while the composer is open, so the header never changes its shape. Offline it stays in
            // place, disabled, and says why.
            <Show
              when={props.offline}
              fallback={
                <Button variant="ghost" size="xs" disabled={composerOpen()} onClick={() => setComposerOpen(true)}>
                  <i class="ti ti-plus" aria-hidden="true" /> {t().comment}
                </Button>
              }
            >
              <Tooltip.Anchor content={t().needsConnection}>
                <Button variant="ghost" size="xs" disabled aria-label={`${t().comment}: ${t().needsConnection}`}>
                  <i class="ti ti-plus" aria-hidden="true" /> {t().comment}
                </Button>
              </Tooltip.Anchor>
            </Show>
          ) : undefined
        }
      >
        <Discussion.List
          loading={(commentsQuery.loading() || commentsQuery.refreshing()) && commentsPage().items.length === 0}
          loadingLabel={t().loadingComments}
          error={commentsQuery.error()?.message}
          onRetry={() => commentsQuery.refresh()}
          hasMore={commentsPage().hasNext}
          loadingMore={commentsQuery.loadingMore()}
          loadMoreLabel={t().loadEarlierComments}
          onLoadMore={() => commentsQuery.loadMore()}
          fold={NEWEST}
          expanded={expanded()}
          onExpandedChange={setExpanded}
        >
          <For each={commentsPage().items}>
            {(comment) => {
              const isOwn = () => comment.authorUserId === props.currentUserId;
              const isEditing = () => editingId() === comment.id;
              return (
                <Discussion.Item
                  data-note-comment={comment.id}
                  tabIndex={-1}
                  avatar={
                    <CloudAvatar
                      username={comment.authorDisplayName}
                      userId={comment.authorUserId}
                      avatarHash={comment.authorAvatarHash}
                      size="xs"
                    />
                  }
                  author={isOwn() ? t().you : comment.authorDisplayName}
                  timestamp={
                    <Tooltip.Anchor content={exactTime(comment.createdAt)}>
                      {/* Focusable, so the exact date also shows from the keyboard. */}
                      <time dateTime={comment.createdAt} tabIndex={0}>
                        {dates.formatDateTimeRelative(comment.createdAt, props.dateConfig)}
                      </time>
                    </Tooltip.Anchor>
                  }
                  meta={comment.updatedAt !== comment.createdAt ? <span>{t().editedLower}</span> : undefined}
                  actions={
                    props.canWrite && isOwn() && !isEditing() && (comment.canEdit || comment.canDelete) ? (
                      <>
                        <Show when={comment.canEdit}>
                          <Tooltip.Anchor content={t().editComment}>
                            <IconButton
                              tooltip={false}
                              variant="ghost"
                              size="xs"
                              onClick={() => setEditingId(comment.id)}
                              label={t().editComment}
                            >
                              <i class="ti ti-pencil" aria-hidden="true" />
                            </IconButton>
                          </Tooltip.Anchor>
                        </Show>
                        <Show when={comment.canDelete}>
                          <Tooltip.Anchor content={t().deleteComment}>
                            <IconButton
                              variant="ghost"
                              size="xs"
                              onClick={() => void deleteComment(comment)}
                              disabled={deleteConfirming() || deleteMutation.loading()}
                              label={t().deleteComment}
                              tooltip={false}
                            >
                              <i class="ti ti-trash" aria-hidden="true" />
                            </IconButton>
                          </Tooltip.Anchor>
                        </Show>
                      </>
                    ) : undefined
                  }
                >
                  <Show when={isEditing()} fallback={<MarkdownView markdown={comment.content} headingScale="compact" />}>
                    <Discussion.Composer
                      label={t().editComment}
                      initialValue={comment.content}
                      submitLabel={t().saveComment}
                      cancelLabel={t().cancel}
                      onCancel={() => setEditingId(null)}
                      lines={3}
                      onSubmit={async (content) => {
                        await updateMutation.mutate({
                          notebookId: props.notebookId,
                          noteId: props.noteId,
                          commentId: comment.id,
                          content,
                        });
                        const error = updateMutation.error();
                        if (error) throw error;
                      }}
                    />
                  </Show>
                </Discussion.Item>
              );
            }}
          </For>
        </Discussion.List>
        {/* The composer opens below the newest comment, where the conversation continues. */}
        {composer()}
      </Discussion>
    </Show>
  );
}
