import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Avatar, announce, Discussion, IconButton, MarkdownView, prompts, Tooltip, toast } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceComment } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

type Props = {
  spaceId: string;
  itemId: string;
  recurrenceId: string | null;
  comments: SpaceComment[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadError?: string;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  currentUserId: string;
  onUpdate: () => void;
  dateConfig?: DateContext;
  canWrite: boolean;
};

export default function CommentsSection(props: Props) {
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  const createCommentMutation = mutations.create({
    mutation: async (content: string) => {
      const res = await apiClient[":id"].items[":itemId"].comments.$post({
        param: { id: props.spaceId, itemId: props.itemId },
        query: props.recurrenceId ? { recurrence_id: props.recurrenceId } : {},
        json: { content },
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res, t.addCommentFailed));
      }
      return res.json();
    },
    // The new comment appears in the list, and a screen reader is told because focus stays in the composer. A failure
    // stays under the composer, which keeps the draft.
    onSuccess: () => {
      announce(t.commentAdded);
      props.onUpdate();
    },
  });

  const deleteCommentMutation = mutations.create<void, string>({
    mutation: async (id: string) => {
      const res = await apiClient[":id"].items[":itemId"].comments[":commentId"].$delete({
        param: { id: props.spaceId, itemId: props.itemId, commentId: id },
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res, t.deleteCommentFailed));
      }
      await res.json();
    },
    // The comment leaves the list together with the control that had focus, so a screen reader is told.
    onSuccess: () => {
      announce(t.commentDeleted);
      props.onUpdate();
    },
    onError: (err) => toast.error(err.message),
  });
  type CommentEdit = { itemId: string; id: string; content: string };
  const updateCommentMutation = mutations.create<void, CommentEdit, { edit: CommentEdit }>({
    onBefore: (edit) => ({ edit }),
    mutation: async ({ itemId, id, content }) => {
      const res = await apiClient[":id"].items[":itemId"].comments[":commentId"].$patch({
        param: { id: props.spaceId, itemId, commentId: id },
        json: { content },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.updateCommentFailed));
      await res.json();
    },
    onSuccess: () => {
      announce(t.commentUpdated);
      props.onUpdate();
    },
    // The edit dialog has closed, so Retry saves the captured text again instead of losing it, and stays until closed.
    onError: (err, context) =>
      retryToast(err.message, t.retry, () => context && updateCommentMutation.mutate(context.edit), { untilClosed: true }),
  });
  const editComment = async (comment: SpaceComment) => {
    const values = await prompts.form({
      title: t.editComment,
      icon: "ti ti-pencil",
      fields: {
        content: {
          type: "text",
          label: t.comment,
          default: comment.content,
          required: true,
          multiline: true,
          lines: 5,
        },
      },
      confirmText: t.saveComment,
    });
    if (!values) return;
    const content = String(values.content ?? "").trim();
    if (!content) return;
    await updateCommentMutation.mutate({ itemId: props.itemId, id: comment.id, content });
  };
  let deletePromptPending = false;
  const deleteComment = async (id: string) => {
    if (deletePromptPending || deleteCommentMutation.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await prompts.confirm(t.deleteCommentQuestion, {
        title: t.deleteComment,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t.delete,
      });
      if (confirmed) void deleteCommentMutation.mutate(id);
    } finally {
      deletePromptPending = false;
    }
  };

  const sortedComments = () => [...props.comments].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <Discussion
      label={props.recurrenceId ? t.occurrenceComments : t.comments}
      icon="ti ti-message"
      count={props.total}
      style="view-transition-name: space-item-detail-comments"
    >
      <Show when={props.canWrite}>
        <Discussion.Composer
          label={t.addComment}
          placeholder={t.commentPlaceholder}
          submitLabel={t.postComment}
          onSubmit={async (content) => {
            await createCommentMutation.mutate(content);
            const error = createCommentMutation.error();
            if (error) throw error;
          }}
        />
      </Show>

      <Discussion.List
        loading={props.loading && sortedComments().length === 0}
        loadingLabel={t.loadingComments}
        error={props.loadError}
        onRetry={props.onRetry}
        hasMore={props.hasMore}
        loadingMore={props.loadingMore}
        loadMoreLabel={t.loadEarlierComments}
        onLoadMore={props.onLoadMore}
      >
        <For each={sortedComments()}>
          {(comment) => (
            <Discussion.Item
              avatar={
                <Avatar
                  name={comment.userName ?? t.unknownUser}
                  src={
                    comment.userId && comment.userAvatarHash
                      ? `/api/accounts/users/${encodeURIComponent(comment.userId)}/avatar?rev=${encodeURIComponent(comment.userAvatarHash)}`
                      : undefined
                  }
                  size="xs"
                />
              }
              author={comment.userName ?? t.unknownUser}
              timestamp={
                <time dateTime={comment.createdAt} title={dates.formatDateTime(comment.createdAt, props.dateConfig)}>
                  {dates.formatDateTimeRelative(comment.createdAt, props.dateConfig)}
                </time>
              }
              actions={
                props.canWrite && (comment.canEdit || comment.canDelete) ? (
                  <>
                    <Show when={comment.canEdit}>
                      <Tooltip.Anchor content={t.editComment}>
                        <IconButton
                          label={t.editComment}
                          size="xs"
                          onClick={() => void editComment(comment)}
                          disabled={updateCommentMutation.loading()}
                        >
                          <i class="ti ti-pencil" aria-hidden="true" />
                        </IconButton>
                      </Tooltip.Anchor>
                    </Show>
                    <Show when={comment.canDelete}>
                      <Tooltip.Anchor content={t.deleteComment}>
                        <IconButton
                          label={t.deleteComment}
                          size="xs"
                          onClick={() => void deleteComment(comment.id)}
                          disabled={deleteCommentMutation.loading()}
                          class="hover:text-red-600 dark:hover:text-red-400"
                        >
                          <i class="ti ti-trash" aria-hidden="true" />
                        </IconButton>
                      </Tooltip.Anchor>
                    </Show>
                  </>
                ) : undefined
              }
            >
              <MarkdownView markdown={comment.content} headingScale="compact" class="text-sm" />
            </Discussion.Item>
          )}
        </For>
      </Discussion.List>
    </Discussion>
  );
}
