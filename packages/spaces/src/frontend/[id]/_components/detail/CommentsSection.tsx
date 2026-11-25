import { cloudAvatarSource } from "@k2b/cloud/account/ui";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce } from "@k2b/ui";
import { Bar, Button, confirm, Dialog, Failed, Field, Input, Loading, Menu, Prose, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
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
  const toast = useToast();
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
    onError: (err) => toast(err.message, { status: "bad" }),
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
  const [draft, setDraft] = createSignal("");
  const [editing, setEditing] = createSignal<SpaceComment | null>(null);
  const [edited, setEdited] = createSignal("");
  const post = async () => {
    const content = draft().trim();
    if (!content || createCommentMutation.loading()) return;
    // A failure keeps the draft and says so below the field.
    const outcome = await createCommentMutation.mutate(content);
    if (outcome === "success") setDraft("");
  };
  const saveEdit = async () => {
    const comment = editing();
    const content = edited().trim();
    if (!comment || !content) return;
    setEditing(null);
    await updateCommentMutation.mutate({ itemId: props.itemId, id: comment.id, content });
  };
  const deleteComment = async (id: string) => {
    if (deleteCommentMutation.loading()) return;
    if (await confirm({ title: t.deleteComment, description: t.deleteCommentQuestion, confirm: t.delete }))
      void deleteCommentMutation.mutate(id);
  };
  const sortedComments = () => [...props.comments].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <Section icon="message-circle" title={props.recurrenceId ? t.occurrenceComments : t.comments} count={props.total}>
      <Show when={props.hasMore}>
        <Bar
          end={
            <Button variant="ghost" busy={props.loadingMore} onClick={() => void props.onLoadMore()}>
              {t.loadEarlierComments}
            </Button>
          }
        />
      </Show>
      <Show when={props.loadError}>{(error) => <Failed text={error()} onRetry={() => void props.onRetry()} />}</Show>
      <Show when={!(props.loading && sortedComments().length === 0)} fallback={<Loading rows={2} lines={2} />}>
        <For each={sortedComments()}>
          {(comment) => (
            <>
              <Row
                avatar={{
                  name: comment.userName ?? t.unknownUser,
                  image: comment.userId && comment.userAvatarHash ? cloudAvatarSource(comment.userId, comment.userAvatarHash) : undefined,
                }}
                lines={[comment.userName ?? t.unknownUser, dates.formatDateTimeRelative(comment.createdAt, props.dateConfig)]}
                end={
                  props.canWrite && (comment.canEdit || comment.canDelete) ? (
                    <Menu
                      label={t.moreActionsFor({ label: comment.userName ?? t.unknownUser })}
                      items={[
                        ...(comment.canEdit
                          ? [
                              {
                                label: t.editComment,
                                icon: "pencil",
                                onClick: () => {
                                  setEdited(comment.content);
                                  setEditing(comment);
                                },
                              },
                            ]
                          : []),
                        ...(comment.canDelete
                          ? [{ label: t.deleteComment, icon: "trash", danger: true, onClick: () => void deleteComment(comment.id) }]
                          : []),
                      ]}
                    />
                  ) : undefined
                }
              />
              <Prose markdown={comment.content} />
            </>
          )}
        </For>
      </Show>
      <Show when={props.canWrite}>
        {/* k2b-ui gap: the chat composer of @k2b/editor is not in v2 yet; a comment is written in a plain multiline field. */}
        <Field label={t.addComment} name="comment" error={createCommentMutation.error()?.message}>
          <Input multiline value={draft()} placeholder={t.commentPlaceholder} onInput={setDraft} />
        </Field>
        <Bar
          end={
            <Button busy={createCommentMutation.loading()} disabled={!draft().trim()} onClick={() => void post()}>
              {t.postComment}
            </Button>
          }
        />
      </Show>
      <Show when={editing()}>
        <Dialog
          title={t.editComment}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          foot={
            <>
              <Button onClick={() => setEditing(null)}>{t.cancel}</Button>
              <Button variant="primary" disabled={!edited().trim()} onClick={() => void saveEdit()}>
                {t.saveComment}
              </Button>
            </>
          }
        >
          <Field label={t.comment} name="comment-edit" required>
            <Input multiline value={edited()} onInput={setEdited} />
          </Field>
        </Dialog>
      </Show>
    </Section>
  );
}
