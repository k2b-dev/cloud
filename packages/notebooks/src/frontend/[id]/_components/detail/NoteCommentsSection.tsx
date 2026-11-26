import { type DateContext, dates, type Paginated } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { announce, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  confirm,
  Failed,
  Field,
  Input,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  type Person,
  Prose,
  Row,
  Section,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
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
  /** Hears the number of comments whenever it changes, for the note's key facts in the details head. */
  onTotal?: (total: number) => void;
};

const PER_PAGE = 30;
/** Comments shown before "n older": the newest few, so the panel's other sections stay in reach. */
const NEWEST = 3;
/** Pages an activity link may load to find its comment: ten pages of 30 cover 300 comments. */
const REVEAL_MAX_PAGES = 10;
const sourceFor = (notebookId: string, noteId: string) => `${notebookId}:${noteId}`;
const parseSource = (source: string) => {
  const [notebookId, noteId] = source.split(":");
  if (!notebookId || !noteId) throw new Error("Invalid note comment source");
  return { notebookId, noteId };
};

export default function NoteCommentsSection(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const toast = useToast();
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
  createEffect(() => props.onTotal?.(commentsPage().total));

  createEffect(() => {
    void source();
    setComposerOpen(false);
    setEditingId(null);
    setExpanded(false);
  });

  /** This section, found by its title (the v2 Section takes no ref). */
  const findSection = () =>
    [...document.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].find(
      (section) => section.getAttribute("aria-label") === t().comments,
    );

  // The activity list links to a comment: page it in when it is older than the loaded pages, unfold the list when
  // it is folded away, then bring it into view. Paging stops after a bounded number of pages.
  onMount(() => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    const reveal = async (event: Event) => {
      const commentId = (event as CustomEvent<RevealCommentEventDetail>).detail?.commentId ?? null;
      // A reveal belongs to the note it started on; switching notes or leaving cancels it after any await.
      const startedOn = source();
      const current = () => active && source() === startedOn;
      const indexOf = () => (commentId ? commentsPage().items.findIndex((comment) => comment.id === commentId) : -1);
      for (let page = 0; commentId && indexOf() < 0 && commentsPage().hasNext && page < REVEAL_MAX_PAGES; page++) {
        const loaded = commentsPage().items.length;
        await commentsQuery.loadMore();
        if (!current()) return;
        // A failed or empty page stops here; the list's own error row offers the retry.
        if (commentsQuery.error() || commentsPage().items.length === loaded) break;
      }
      const index = indexOf();
      if (index >= 0 && index < commentsPage().items.length - NEWEST) setExpanded(true);
      queueMicrotask(() => {
        if (!current()) return;
        // The section is named by its title; its bands stand in the order of the shown comments.
        const section = findSection();
        const shownIndex = index - (commentsPage().items.length - shownComments().length);
        const band = index >= 0 && commentId ? section?.querySelectorAll<HTMLElement>('[data-k2-part="Band"]')[shownIndex] : undefined;
        const target = band ?? section;
        if (!target) return;
        // focusable for this jump only, so a screen reader lands on the comment (or the section) the link named
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.scrollIntoView({ block: "nearest" });
        target.focus({ preventScroll: true });
      });
    };
    const listener = (event: Event) => void reveal(event);
    window.addEventListener(REVEAL_COMMENT_EVENT, listener);
    onCleanup(() => window.removeEventListener(REVEAL_COMMENT_EVENT, listener));
  });

  type CommentTarget = { notebookId: string; noteId: string };
  // The list shows a saved change only after the refresh, so a screen reader hears the outcome only then. When the
  // refresh fails, the error toast already says that the change was saved.
  const reconcile = (target: CommentTarget, outcome: string) => {
    if (source() !== sourceFor(target.notebookId, target.noteId)) return;
    void commentsQuery.invalidate({ cursor: null }).then(
      () => announce(outcome),
      () => void toast(t().commentSavedReloadFailed, { status: "bad" }),
    );
  };

  /** The composer's field, to move the focus into it when it opens. */
  let composerField: HTMLTextAreaElement | HTMLInputElement | undefined;
  /** The head's "Kommentieren": focus returns there when the composer closes. */
  const focusCommentAction = () =>
    // after the head shows the button enabled again
    queueMicrotask(() =>
      [...(findSection()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === t().comment)?.focus(),
    );

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
      if (source() === sourceFor(target.notebookId, target.noteId)) {
        // Focus that was in the composer goes back to the button that opened it, not to the page.
        const hadFocus = composerField !== undefined && composerField === document.activeElement;
        setComposerOpen(false);
        if (hadFocus) focusCommentAction();
      }
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
    onError: (error) => void toast(error.message, { status: "bad" }),
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
      const confirmed = await confirm({
        title: t().deleteComment,
        description: t().deleteCommentConfirm,
        confirm: t().delete,
        cancel: t().cancel,
      });
      if (!confirmed) return;
      await deleteMutation.mutate({ notebookId: props.notebookId, noteId: props.noteId, commentId: comment.id });
    } finally {
      setDeleteConfirming(false);
    }
  };

  /** The newest few, or all once unfolded; the list reads oldest first, so the conversation continues at its end. */
  const shownComments = () => (expanded() ? commentsPage().items : commentsPage().items.slice(-NEWEST));
  const hiddenComments = () => commentsPage().items.length - shownComments().length;
  const [draft, setDraft] = createSignal("");
  const [editDraft, setEditDraft] = createSignal("");
  const submitDraft = async () => {
    const content = draft().trim();
    if (!content || createMutation.loading()) return;
    const outcome = await createMutation.mutate({ notebookId: props.notebookId, noteId: props.noteId, content });
    // A call that did not run keeps the draft.
    if (outcome === "success") {
      setDraft("");
      setComposerOpen(false);
    }
  };
  const submitEdit = async (comment: PublicNoteComment) => {
    const content = editDraft().trim();
    if (!content || updateMutation.loading()) return;
    const outcome = await updateMutation.mutate({ notebookId: props.notebookId, noteId: props.noteId, commentId: comment.id, content });
    if (outcome === "success") setEditingId(null);
  };
  const commentMenu = (comment: PublicNoteComment): MenuEntry[] => [
    ...(comment.canEdit
      ? [
          {
            label: t().editComment,
            icon: "pencil",
            onClick: () => {
              setEditDraft(comment.content);
              setEditingId(comment.id);
            },
          },
        ]
      : []),
    ...(comment.canDelete
      ? [
          {
            label: t().deleteComment,
            icon: "trash",
            danger: true,
            disabled: deleteConfirming() || deleteMutation.loading(),
            onClick: () => deleteComment(comment),
          },
        ]
      : []),
  ];
  const person = (comment: PublicNoteComment): Person => ({
    name: comment.authorDisplayName,
    image:
      comment.authorAvatarHash && comment.authorUserId
        ? `/api/accounts/users/${encodeURIComponent(comment.authorUserId)}/avatar?rev=${encodeURIComponent(comment.authorAvatarHash)}`
        : undefined,
  });

  return (
    <Show when={props.canWrite || commentsPage().total > 0}>
      <Section
        icon="message-circle"
        title={t().comments}
        count={commentsPage().total || undefined}
        // Stays in the head while the composer is open, so the head never changes its shape; offline it waits, disabled.
        actions={
          props.canWrite
            ? [{ label: t().comment, icon: "plus", disabled: composerOpen() || !!props.offline, onClick: () => setComposerOpen(true) }]
            : undefined
        }
        more={
          hiddenComments() > 0
            ? { label: t().showOlderComments({ count: hiddenComments() }), onClick: () => setExpanded(true) }
            : commentsPage().hasNext
              ? { label: t().loadEarlierComments, onClick: () => void commentsQuery.loadMore() }
              : undefined
        }
      >
        <Switch>
          <Match when={commentsQuery.error() && commentsPage().items.length === 0}>
            <Failed text={commentsQuery.error()?.message ?? t().loadingComments} onRetry={() => void commentsQuery.refresh()} />
          </Match>
          <Match when={(commentsQuery.loading() || commentsQuery.refreshing()) && commentsPage().items.length === 0}>
            <Loading rows={2} lines={2} />
          </Match>
          <Match when={commentsPage().items.length === 0 && !composerOpen()}>
            <Text type="meta" muted>
              {t().noneYet}
            </Text>
          </Match>
        </Switch>
        <For each={shownComments()}>
          {(comment) => {
            const isOwn = () => comment.authorUserId === props.currentUserId;
            const isEditing = () => editingId() === comment.id;
            return (
              <Band>
                {/* Two lines, the time on the second: in a row of one line the "…" of an own comment would stand on it. */}
                <Row
                  avatar={person(comment)}
                  lines={[
                    isOwn() ? t().you : comment.authorDisplayName,
                    [
                      dates.formatDateTimeRelative(comment.createdAt, props.dateConfig),
                      comment.updatedAt !== comment.createdAt ? t().editedLower : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ]}
                  end={
                    props.canWrite && isOwn() && !isEditing() && (comment.canEdit || comment.canDelete) ? (
                      <Menu label={t().commentActions} items={commentMenu(comment)} />
                    ) : undefined
                  }
                />
                <Show
                  when={isEditing()}
                  fallback={
                    // k2b-ui gap: Prose renders no images or tables, which a comment's Markdown may hold; it shows them as text.
                    <Prose markdown={comment.content} />
                  }
                >
                  <Field label={t().editComment} name="comment" error={updateMutation.error()?.message}>
                    <Input multiline value={editDraft()} disabled={updateMutation.loading()} onInput={setEditDraft} />
                  </Field>
                  <Bar
                    end={
                      <>
                        <Button onClick={() => setEditingId(null)}>{t().cancel}</Button>
                        <Button busy={updateMutation.loading()} onClick={() => void submitEdit(comment)}>
                          {t().saveComment}
                        </Button>
                      </>
                    }
                  />
                </Show>
              </Band>
            );
          }}
        </For>
        {/* An older page that failed keeps the loaded comments and says so after them, with the retry. */}
        <Show when={commentsQuery.error() && commentsPage().items.length > 0}>
          <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void commentsQuery.loadMore() }]}>
            {commentsQuery.error()?.message}
          </Notice>
        </Show>
        {/* The composer opens below the newest comment, where the conversation continues. */}
        <Show when={props.canWrite && composerOpen()}>
          {/* A comment the server refused keeps the draft, with the reason at the field. */}
          <Field label={t().addComment} name="comment" error={createMutation.error()?.message}>
            <Input
              multiline
              ref={(field) => {
                composerField = field;
                // The button that opened it turns disabled, so the focus moves into the composer, which comes into view.
                requestAnimationFrame(() => {
                  if (!field.isConnected) return;
                  field.scrollIntoView({ block: "nearest" });
                  field.focus({ preventScroll: true });
                });
              }}
              value={draft()}
              placeholder={t().commentPlaceholder}
              disabled={createMutation.loading()}
              onInput={setDraft}
            />
          </Field>
          <Bar
            end={
              <>
                <Button
                  onClick={() => {
                    setComposerOpen(false);
                    focusCommentAction();
                  }}
                >
                  {t().cancel}
                </Button>
                <Button busy={createMutation.loading()} disabled={!draft().trim()} onClick={() => void submitDraft()}>
                  {t().postComment}
                </Button>
              </>
            }
          />
        </Show>
      </Section>
    </Show>
  );
}
