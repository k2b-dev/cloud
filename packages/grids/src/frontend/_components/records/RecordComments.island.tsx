import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Button, DetailPanel, Discussion, IconButton, MarkdownView, prompts, TextInput, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { PublicRecordComment as RecordComment } from "../../../api/public-dto";
import { recordMessages } from "./messages";

type CommentPermissions = { actorUserId: string | null; canWrite: boolean; canModerate: boolean };
type CommentsResponse = { items: RecordComment[]; nextCursor: string | null; permissions: CommentPermissions };

type Props = {
  endpoint: string;
  title?: string;
  dateConfig?: DateContext;
};

const responseError = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response.json().catch(() => null);
  return payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : fallback;
};

const withCursor = (endpoint: string, cursor: string): string => {
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("cursor", cursor);
  return `${url.pathname}${url.search}`;
};

const relativeTime = (value: string, dateConfig?: DateContext): string => {
  const elapsed = Date.now() - new Date(value).getTime();
  const locale = dateConfig?.locale ?? "en";
  if (elapsed < 60_000) return recordMessages.resolve([locale]).t.justNow;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), "hour");
  if (elapsed < 604_800_000) return relative.format(-Math.floor(elapsed / 86_400_000), "day");
  return dates.formatDate(value, dateConfig);
};

export default function RecordComments(props: Props) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const [comments, setComments] = createSignal<RecordComment[]>([]);
  const [permissions, setPermissions] = createSignal<CommentPermissions>({ actorUserId: null, canWrite: false, canModerate: false });
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingBody, setEditingBody] = createSignal("");
  const [savingId, setSavingId] = createSignal<string | null>(null);
  let requestSequence = 0;

  const load = async (cursor?: string, append = false): Promise<boolean> => {
    const sequence = ++requestSequence;
    append ? setLoadingOlder(true) : setLoading(true);
    if (!append) setError(null);
    try {
      const response = await fetch(cursor ? withCursor(props.endpoint, cursor) : props.endpoint, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(await responseError(response, t().commentLoadFailed));
      const page = (await response.json()) as CommentsResponse;
      if (sequence !== requestSequence) return false;
      setComments((current) => (append ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setPermissions(page.permissions);
      return true;
    } catch (cause) {
      if (sequence !== requestSequence) return false;
      const message = cause instanceof Error ? cause.message : t().commentLoadFailed;
      if (append) throw cause;
      setError(message);
      return false;
    } finally {
      if (sequence === requestSequence) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  };

  createEffect(() => {
    const endpoint = props.endpoint;
    if (!endpoint) return;
    setComments([]);
    setNextCursor(null);
    setComposerOpen(false);
    void load();
  });

  const canManage = (comment: RecordComment) =>
    !comment.deletedAt &&
    Boolean(permissions().canModerate || (comment.authorUserId && comment.authorUserId === permissions().actorUserId));

  const post = async (body: string): Promise<boolean> => {
    const normalized = body.trim();
    if (!normalized) return false;
    const temporaryId = `pending-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setComments((current) => [
      {
        id: temporaryId,
        authorUserId: permissions().actorUserId,
        authorDisplayName: t().you,
        authorAvatarHash: null,
        body: normalized,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      ...current,
    ]);
    try {
      const response = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ body: normalized }),
      });
      if (!response.ok) throw new Error(await responseError(response, t().commentPostFailed));
      const created = (await response.json()) as RecordComment;
      setComments((current) => current.map((comment) => (comment.id === temporaryId ? created : comment)));
      setComposerOpen(false);
      toast.success(t().commentPosted);
      return true;
    } catch (cause) {
      setComments((current) => current.filter((comment) => comment.id !== temporaryId));
      prompts.error(cause instanceof Error ? cause.message : t().commentPostFailed);
      return false;
    }
  };

  const saveEdit = async (comment: RecordComment) => {
    const normalized = editingBody().trim();
    if (!normalized || savingId()) return;
    setSavingId(comment.id);
    try {
      const response = await fetch(`${props.endpoint}/${encodeURIComponent(comment.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ body: normalized }),
      });
      if (!response.ok) throw new Error(await responseError(response, t().commentUpdateFailed));
      const updated = (await response.json()) as RecordComment;
      setComments((current) => current.map((item) => (item.id === comment.id ? updated : item)));
      setEditingId(null);
      toast.success(t().commentUpdated);
    } catch (cause) {
      prompts.error(cause instanceof Error ? cause.message : t().commentUpdateFailed);
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (comment: RecordComment) => {
    if (
      !(await prompts.confirm(t().deleteCommentDetail, {
        title: t().deleteCommentTitle,
        variant: "danger",
        confirmText: t().delete,
      }))
    )
      return;
    setSavingId(comment.id);
    try {
      const response = await fetch(`${props.endpoint}/${encodeURIComponent(comment.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, t().commentDeleteFailed));
      const now = new Date().toISOString();
      setComments((current) =>
        current.map((item) => (item.id === comment.id ? { ...item, body: null, deletedAt: now, updatedAt: now } : item)),
      );
      toast.success(t().deletedComment);
    } catch (cause) {
      prompts.error(cause instanceof Error ? cause.message : t().commentDeleteFailed);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <DetailPanel.Group label={t().recordComments}>
      <DetailPanel.Section
        title={props.title ?? t().comments}
        icon="ti ti-messages"
        meta={comments().length}
        actions={
          permissions().canWrite && !composerOpen() ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setComposerOpen(true)}>
              <i class="ti ti-plus" aria-hidden="true" /> {t().addComment}
            </Button>
          ) : undefined
        }
      >
        <div class="flex min-w-0 flex-col gap-3">
          <Discussion.List
            loading={loading() && comments().length === 0}
            loadingLabel={t().loadingComments}
            error={error()}
            onRetry={async () => {
              await load();
            }}
            hasMore={nextCursor() !== null}
            loadingMore={loadingOlder()}
            loadMoreLabel={t().loadEarlierComments}
            onLoadMore={() => {
              const cursor = nextCursor();
              return cursor ? load(cursor, true) : false;
            }}
          >
            <For each={[...comments()].reverse()}>
              {(comment) => (
                <Discussion.Item
                  aria-busy={comment.id.startsWith("pending-") ? "true" : undefined}
                  avatar={
                    <Avatar
                      name={comment.authorDisplayName}
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
                    <Tooltip.Anchor content={dates.formatDateTime(comment.createdAt, props.dateConfig)}>
                      <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt, props.dateConfig)}</time>
                    </Tooltip.Anchor>
                  }
                  meta={comment.updatedAt !== comment.createdAt && !comment.deletedAt ? t().edited : undefined}
                  actions={
                    canManage(comment) && !comment.id.startsWith("pending-") ? (
                      <>
                        <Tooltip.Anchor content={t().editComment}>
                          <IconButton
                            type="button"
                            label={t().editComment}
                            variant="ghost"
                            size="sm"
                            class="h-7! w-7!"
                            disabled={Boolean(savingId())}
                            onClick={() => {
                              setEditingId(comment.id);
                              setEditingBody(comment.body ?? "");
                            }}
                          >
                            <i class="ti ti-pencil" aria-hidden="true" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content={t().deleteComment}>
                          <IconButton
                            type="button"
                            label={t().deleteComment}
                            variant="ghost"
                            size="sm"
                            class="h-7! w-7! hover:text-danger"
                            disabled={Boolean(savingId())}
                            onClick={() => void remove(comment)}
                          >
                            <i class="ti ti-trash" aria-hidden="true" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </>
                    ) : undefined
                  }
                >
                  <Show
                    when={editingId() === comment.id}
                    fallback={
                      <Show
                        when={!comment.deletedAt && comment.body}
                        fallback={<p class="mt-1 text-sm italic text-dimmed">{t().deletedComment}</p>}
                      >
                        {(markdown) => <MarkdownView markdown={markdown()} headingScale="compact" />}
                      </Show>
                    }
                  >
                    <form
                      class="mt-2 flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveEdit(comment);
                      }}
                    >
                      <TextInput
                        aria-label={t().editComment}
                        value={() => editingBody()}
                        onValueChange={setEditingBody}
                        markdown
                        disabled={savingId() === comment.id}
                      />
                      <div class="flex justify-end gap-2">
                        <Button type="button" variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                          {t().cancel}
                        </Button>
                        <Button type="submit" size="sm" disabled={!editingBody().trim() || savingId() === comment.id}>
                          {t().saveChanges}
                        </Button>
                      </div>
                    </form>
                  </Show>
                </Discussion.Item>
              )}
            </For>
          </Discussion.List>

          <Show when={permissions().canWrite && composerOpen()}>
            <Discussion.Composer
              label={t().addComment}
              placeholder={t().writeComment}
              submitLabel={t().postComment}
              cancelLabel={t().cancel}
              onCancel={() => setComposerOpen(false)}
              onSubmit={post}
            />
          </Show>
        </div>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
