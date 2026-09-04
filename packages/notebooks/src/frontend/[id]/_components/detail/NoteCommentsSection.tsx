import { type DateContext, dates, type Paginated } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Avatar, Button, Discussion, IconButton, MarkdownView, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicNoteComment } from "@/api/public-resources";
import { notebookWorkspaceMessages } from "../../messages";
import { readErrorMessage } from "../settings/utils";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";

type Props = {
  notebookId: string;
  noteId: string;
  currentUserId: string;
  canWrite: boolean;
  initialCommentsPage?: Paginated<PublicNoteComment>;
  dateConfig: DateContext;
};

const PER_PAGE = 30;
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
  });

  type CommentTarget = { notebookId: string; noteId: string };
  const reconcile = (target: CommentTarget) => {
    if (source() !== sourceFor(target.notebookId, target.noteId)) return;
    void commentsQuery.invalidate({ cursor: null }).catch(() => toast.error(t().commentSavedReloadFailed));
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
    onSuccess: ({ target }) => {
      if (source() === sourceFor(target.notebookId, target.noteId)) setComposerOpen(false);
      toast.success(t().commentAdded);
      reconcile(target);
    },
    onError: (error) => prompts.error(error.message),
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
    onSuccess: ({ target }) => {
      if (source() === sourceFor(target.notebookId, target.noteId)) setEditingId(null);
      toast.success(t().commentUpdated);
      reconcile(target);
    },
    onError: (error) => prompts.error(error.message),
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
    onSuccess: (target) => {
      toast.success(t().commentDeleted);
      reconcile(target);
    },
    onError: (error) => prompts.error(error.message),
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

  return (
    <Show when={props.canWrite || commentsPage().total > 0}>
      <Discussion
        label={t().comments}
        icon="ti ti-message"
        count={commentsPage().total}
        actions={
          props.canWrite && !composerOpen() ? (
            <Button variant="ghost" size="xs" onClick={() => setComposerOpen(true)}>
              <i class="ti ti-plus" aria-hidden="true" /> {t().addComment}
            </Button>
          ) : undefined
        }
      >
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
              return createMutation.error() === null;
            }}
          />
        </Show>

        <Discussion.List
          loading={(commentsQuery.loading() || commentsQuery.refreshing()) && commentsPage().items.length === 0}
          loadingLabel={t().loadingComments}
          error={commentsQuery.error()?.message}
          onRetry={() => commentsQuery.refresh()}
          hasMore={commentsPage().hasNext}
          loadingMore={commentsQuery.loadingMore()}
          loadMoreLabel={t().loadEarlierComments}
          onLoadMore={() => commentsQuery.loadMore()}
        >
          <For each={commentsPage().items}>
            {(comment) => {
              const isOwn = () => comment.authorUserId === props.currentUserId;
              const isEditing = () => editingId() === comment.id;
              return (
                <Discussion.Item
                  avatar={
                    <Avatar
                      name={comment.authorDisplayName}
                      fallback={(comment.authorDisplayName.trim() || "?").slice(0, 2).toUpperCase()}
                      src={
                        comment.authorUserId && comment.authorAvatarHash
                          ? `/api/accounts/users/${encodeURIComponent(comment.authorUserId)}/avatar?rev=${encodeURIComponent(comment.authorAvatarHash)}`
                          : undefined
                      }
                      size="xs"
                    />
                  }
                  author={comment.authorDisplayName}
                  timestamp={
                    <time dateTime={comment.createdAt} title={dates.formatDateTime(comment.createdAt, props.dateConfig)}>
                      {dates.formatDateTimeRelative(comment.createdAt, props.dateConfig)}
                    </time>
                  }
                  meta={comment.updatedAt !== comment.createdAt ? <span>{t().edited}</span> : undefined}
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
                        return updateMutation.error() === null;
                      }}
                    />
                  </Show>
                </Discussion.Item>
              );
            }}
          </For>
        </Discussion.List>
      </Discussion>
    </Show>
  );
}
