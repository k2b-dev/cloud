import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { SaveFilesButton } from "@k2b/cloud/browser/files";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Avatar,
  AvatarStack,
  announce,
  Button,
  ButtonLink,
  ColorInput,
  DateTimePicker,
  DescriptionList,
  DetailPanel,
  Discussion,
  Dropdown,
  type DropdownItem,
  FileGrid,
  FileTypeIcon,
  fileKindLabel,
  formatFileViewSize,
  IconButton,
  IconButtonLink,
  MarkdownView,
  MultiSelectInput,
  openSpotlightSearch,
  Placeholder,
  prompts,
  SegmentedControl,
  Skeleton,
  StatusBadge,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../command-messages";
import type { ConversationDraftSummary } from "../../contracts";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "../../service/collaboration";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";
import type { ConversationPresenceParticipant } from "../../service/presence";
import type { ConversationReminder } from "../../service/reminders";
import type { MailDetailErrors, MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import MailConversationContext, { type MailContextParts } from "./MailConversationContext";
import { canPreviewAttachment, openAttachmentPreview, saveSource } from "./MailMessageAttachments";
import { createRelatedConversations, MailRelatedConversationsView } from "./MailRelatedConversations";
import { presentMailActivity } from "./mail-activity-presentation";
import { useMailCloudId } from "./mail-cloud-id";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { attachmentsByMessage, isThumbnailImage, type MailDetailFile, mergeMailAttachments } from "./mail-detail-attachments";
import { describeUnavailableMailDetails } from "./mail-detail-availability";
import {
  applyMailCollaborationPatch,
  applyMailTagIds,
  createMailDetailUpdateQueue,
  type MailCollaborationPatch,
  queuedCollaborationPatch,
  queuedReminderDueAt,
  queuedTagIds,
} from "./mail-detail-update-queue";
import { mailDetailsMessages } from "./mail-details-messages";
import {
  reconcileAvailableTags,
  reconcileCollaboration,
  reconcileComments,
  reconcileConversationTags,
  reconcileReminder,
} from "./mail-details-reconciliation";
import { createRetryToasts } from "./mail-feedback";
import { mailMessageMessages } from "./mail-message-messages";

// Local on purpose: `@k2b/cloud/account/ui` would pull Zod into the mailbox's first load (mailbox-first-load.test.ts).
const cloudAvatarSource = (userId: string | null | undefined, avatarHash: string | null | undefined): string | undefined =>
  userId && avatarHash ? `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}` : undefined;

type InspectorTab = "headers" | "source";

/** Starts a download of a file the browser cannot preview. */
const downloadUrl = (href: string, name: string) => {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
};

/**
 * The details panel while the conversation's details load: the outline's own rows at their real heights, so nothing
 * moves when the details arrive.
 */
export function MailDetailsSkeleton(props: { label: string }) {
  const rows = (count: number, kind: "property" | "file") => (
    <For each={Array.from({ length: count }, (_, index) => index)}>
      {(index) =>
        kind === "property" ? (
          <div class="mail-details-skeleton__property">
            <Skeleton class="mail-details-skeleton__term" />
            <Skeleton class={`mail-details-skeleton__value mail-details-skeleton__value--${index % 3}`} />
          </div>
        ) : (
          <div class="mail-details-skeleton__file">
            <Skeleton class="mail-details-skeleton__thumb" />
            <span class="mail-details-skeleton__lines">
              <Skeleton class="mail-details-skeleton__name" />
              <Skeleton class="mail-details-skeleton__meta" />
            </span>
          </div>
        )
      }
    </For>
  );
  return (
    <div class="mail-details-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label={props.label}>
      <Skeleton class="mail-details-skeleton__kind" />
      <Skeleton class="mail-details-skeleton__title" />
      <Skeleton class="mail-details-skeleton__subtitle" />
      <div class="mail-details-skeleton__section">{rows(4, "property")}</div>
      <div class="mail-details-skeleton__section">{rows(2, "file")}</div>
      <div class="mail-details-skeleton__section">{rows(3, "file")}</div>
    </div>
  );
}

export default function MailDetailsPanel(props: {
  mailboxId: string;
  conversationId: string;
  active: boolean;
  canWrite: boolean;
  /**
   * False for a person who sees only the conversations assigned to them: they cannot change assignees
   * or create tags, and the related mail and contact context, which look beyond the conversation, stay hidden.
   */
  mailboxWide: boolean;
  initialState: ConversationCollaboration;
  initialLocalTags: LocalTag[];
  initialConversationLocalTags: ConversationLocalTags;
  initialComments: ConversationComment[];
  initialCommentsCursor: string | null;
  assignableUsers: MailAssignableUser[];
  presence: ConversationPresenceParticipant[];
  /** The viewer, listed last among the people here and never in the header's avatar stack. */
  currentUserId?: string;
  activity: MailActivityEvent[];
  initialReminder: ConversationReminder | null;
  detailErrors: MailDetailErrors;
  conversationDrafts: ConversationDraftSummary[];
  conversationHref?: string;
  conversationSummary?: ConversationContentSummary | null;
  messages: MailWorkspaceMessage[];
  subject: string;
  requestUrl: string;
  dateConfig: DateContext;
  onCollaborationChange: (state: ConversationCollaboration) => void;
  onConversationTagsChange: (state: ConversationLocalTags) => void;
  onClose: () => void;
  onOpenHref: (href: string) => void | Promise<void>;
  onReconcile: () => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const canAssign = () => props.canWrite && props.mailboxWide;
  const retryToast = createRetryToasts();
  const cloudId = useMailCloudId();
  const [inspectorLoading, setInspectorLoading] = createSignal<InspectorTab | null>(null);
  /** The inspector loads its code on first use; until its modal opens, another activation must not open a second one. */
  const openMessageInspector = async (messageId: string, initialTab: InspectorTab) => {
    if (inspectorLoading()) return;
    setInspectorLoading(initialTab);
    const inspector = await importOnDemand(() => import("./MailMessageInspectorDialog"));
    setInspectorLoading(null);
    if (!inspector) return;
    await inspector.openMailMessageInspector({
      mailboxId: props.mailboxId,
      messages: props.messages,
      initialMessageId: messageId,
      initialTab,
    });
  };
  const [state, setState] = createSignal(props.initialState);
  const [availableTags, setAvailableTags] = createSignal(props.initialLocalTags);
  const [tagState, setTagState] = createSignal(props.initialConversationLocalTags);
  const [comments, setComments] = createSignal(props.initialComments);
  let disposed = false;
  const [commentsCursor, setCommentsCursor] = createSignal(props.initialCommentsCursor);
  const [loadingOlderComments, setLoadingOlderComments] = createSignal(false);
  const [reminderDueAt, setReminderDueAt] = createSignal(props.initialReminder?.state === "pending" ? props.initialReminder.dueAt : null);
  let confirmedState = props.initialState;
  let confirmedTagState = props.initialConversationLocalTags;
  let confirmedReminder = props.initialReminder;
  let confirmedAvailableTagIds = new Set(props.initialLocalTags.map((tag) => tag.id));
  let commentsHistoryExtended = false;
  let commentsHistoryRequest = 0;
  const latestMessage = () => props.messages.at(-1);
  const activityItems = createMemo(() => presentMailActivity(props.activity, locale()));
  const visibleComments = createMemo(() => comments().filter((comment) => !comment.deletedAt));
  const addressList = (addresses: Array<{ name: string | null; address: string }>) =>
    addresses.map((address) => address.name || address.address).join(", ");

  const applyCollaborationPatch = (current: ConversationCollaboration, patch: MailCollaborationPatch) =>
    applyMailCollaborationPatch(current, patch, props.assignableUsers);

  const applyTagIds = (current: ConversationLocalTags, tagIds: readonly string[]) => applyMailTagIds(current, availableTags(), tagIds);

  type DetailUpdateResult =
    | { kind: "collaboration"; value: ConversationCollaboration }
    | { kind: "tags"; value: ConversationLocalTags }
    | { kind: "reminder"; value: ConversationReminder };

  const detailUpdates = createMailDetailUpdateQueue<DetailUpdateResult>({
    run: async (operation, signal) => {
      const param = { mailboxId: props.mailboxId, conversationId: props.conversationId };
      if (operation.kind === "collaboration") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].collaboration.$patch(
          { param, json: { expectedRevision: confirmedState.revision, ...operation.patch } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().updateConversationFailed));
        return { kind: "collaboration", value: await response.json() };
      }
      if (operation.kind === "tags") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"]["local-tags"].$put(
          { param, json: { expectedRevision: confirmedState.revision, tagIds: operation.tagIds } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().updateTagsFailed));
        return { kind: "tags", value: await response.json() };
      }
      if (operation.kind === "reminder") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$put(
          { param, json: { dueAt: operation.dueAt, expectedRevision: confirmedReminder?.revision ?? null } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().setReminderFailed));
        return { kind: "reminder", value: await response.json() };
      }
      if (!confirmedReminder || confirmedReminder.state !== "pending") {
        throw new Error(t().noPendingReminder);
      }
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$delete(
        { param, json: { expectedRevision: confirmedReminder.revision } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().cancelReminderFailed));
      return { kind: "reminder", value: await response.json() };
    },
    onSuccess: (result, _operation, queued) => {
      if (result.kind === "collaboration") {
        confirmedState = reconcileCollaboration(confirmedState, result.value);
        confirmedTagState = {
          ...confirmedTagState,
          conversationRevision: confirmedState.revision,
        };
        setState(applyCollaborationPatch(confirmedState, queuedCollaborationPatch(queued)));
        setTagState((current) => ({ ...current, conversationRevision: confirmedState.revision }));
        props.onCollaborationChange(confirmedState);
        return;
      }
      if (result.kind === "tags") {
        confirmedTagState = reconcileConversationTags(confirmedTagState, result.value);
        confirmedState = {
          ...confirmedState,
          revision: Math.max(confirmedState.revision, confirmedTagState.conversationRevision),
        };
        const pendingTags = queuedTagIds(queued);
        setTagState(pendingTags ? applyTagIds(confirmedTagState, pendingTags) : confirmedTagState);
        setState(applyCollaborationPatch(confirmedState, queuedCollaborationPatch(queued)));
        props.onConversationTagsChange(confirmedTagState);
        return;
      }
      confirmedReminder = reconcileReminder(confirmedReminder, result.value);
      const pendingReminder = queuedReminderDueAt(queued);
      setReminderDueAt(
        pendingReminder.pending ? pendingReminder.dueAt : confirmedReminder?.state === "pending" ? confirmedReminder.dueAt : null,
      );
    },
    onError: async (error) => {
      setState(confirmedState);
      setTagState(confirmedTagState);
      setReminderDueAt(confirmedReminder?.state === "pending" ? confirmedReminder.dueAt : null);
      await prompts.error(error.message, { title: t().conversationChanged });
      await props.onReconcile();
    },
  });

  const snoozeDescription = () => {
    const until = state().snoozedUntil;
    return until ? t().snoozeScheduled({ date: dates.formatDateTime(until, props.dateConfig) }) : t().snoozeQuestion;
  };

  const updateCollaboration = (patch: MailCollaborationPatch) => {
    setState((current) => applyCollaborationPatch(current, patch));
    detailUpdates.enqueue({ kind: "collaboration", patch });
  };

  const updateConversationTags = (tagIds: string[]) => {
    setTagState((current) => applyTagIds(current, tagIds));
    detailUpdates.enqueue({ kind: "tags", tagIds });
  };

  const updateReminder = (dueAt: string) => {
    setReminderDueAt(dueAt);
    detailUpdates.enqueue({ kind: "reminder", dueAt });
  };

  const clearReminder = () => {
    setReminderDueAt(null);
    detailUpdates.enqueue({ kind: "cancel_reminder" });
  };

  createEffect(() => {
    if (!props.active) return;
    const conversationId = props.conversationId;
    const copy = mailCommandMessages.resolve([locale()]).t;
    if (canAssign() && !props.detailErrors.assignableUsers)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `mail.${conversationId}.assign`,
          title: copy.assignTitle,
          description: copy.assignDescription({ subject: props.subject || t().noSubject }),
          icon: "ti ti-user-check",
          action: async () => {
            // Choosing a person toggles them: an assignee is removed, anyone else is added.
            const assigned = new Set(state().assignees.map((user) => user.id));
            const selected = await openSpotlightSearch<string>({
              title: t().assignees,
              icon: "ti ti-user-check",
              placeholder: t().searchPeople,
              minQueryLength: 0,
              noResultsText: t().noAssignablePeople,
              resolve: async ({ query }) => {
                const needle = query.trim().toLocaleLowerCase();
                return props.assignableUsers
                  .filter((user) => !needle || `${user.displayName} ${user.uid}`.toLocaleLowerCase().includes(needle))
                  .map((user) => ({
                    label: assigned.has(user.id) ? t().removeAssignee({ name: user.displayName }) : user.displayName,
                    desc: user.description,
                    icon: assigned.has(user.id) ? "ti ti-user-minus" : "ti ti-user-plus",
                    value: user.id,
                  }));
              },
            });
            const userId = selected?.value;
            if (!userId || !props.active || props.conversationId !== conversationId || !canAssign()) return;
            const current = state().assignees.map((user) => user.id);
            updateCollaboration({
              assigneeUserIds: current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
            });
          },
        }),
      );
    if (!props.detailErrors.reminder)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `mail.${conversationId}.reminder`,
          title: copy.reminderTitle,
          description: copy.reminderDescription({ subject: props.subject || t().noSubject }),
          icon: "ti ti-bell",
          action: async () => {
            const selected = await prompts.form({
              title: t().personalReminder,
              fields: {
                dueAt: {
                  type: "datetime",
                  label: t().personalReminder,
                  required: true,
                  default: reminderDueAt() ?? undefined,
                },
              },
            });
            if (selected?.dueAt && props.active && props.conversationId === conversationId) updateReminder(selected.dueAt);
          },
        }),
      );
  });

  const createTagMutation = mutations.create<LocalTag, { name: string; color: string }>({
    mutation: async (values, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["local-tags"].$post(
        {
          param: { mailboxId: props.mailboxId },
          json: values,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().createTagFailed));
      return response.json();
    },
    onSuccess: (created) => {
      confirmedAvailableTagIds.add(created.id);
      setAvailableTags((current) =>
        [...current.filter((tag) => tag.id !== created.id), created].sort((left, right) => left.name.localeCompare(right.name)),
      );
      toast.success(t().createdTag({ name: created.name }));
    },
    onError: (error) => toast.error(error.message),
  });

  const createTag = async () => {
    const values = await prompts.dialog<{ name: string; color: string } | null>(
      (close) => {
        const [name, setName] = createSignal("");
        const [color, setColor] = createSignal("#6b7280");
        return (
          <form
            class="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name().trim()) close({ name: name().trim(), color: color() });
            }}
          >
            <TextInput label={t().name} placeholder={t().tagName} value={name} onValueChange={setName} required />
            <ColorInput label={t().color} value={color} onValueChange={setColor} />
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
                {t().cancel}
              </Button>
              <Button size="sm" type="submit" disabled={!name().trim()}>
                <i class="ti ti-tag-plus" aria-hidden="true" /> {t().createTag}
              </Button>
            </div>
          </form>
        );
      },
      { title: t().createTag, icon: "ti ti-tag-plus" },
    );
    if (values) await createTagMutation.mutate(values);
  };

  const addComment = mutations.create<ConversationComment, string>({
    mutation: async (body, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments.$post(
        {
          param: {
            mailboxId: props.mailboxId,
            conversationId: props.conversationId,
          },
          json: {
            body,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().addCommentFailed));
      return response.json();
    },
    // The new note appears in the list, and a screen reader is told because focus stays in the composer. A failure
    // stays under the composer, which keeps the draft.
    onSuccess: (comment) => {
      setComments((current) => [...current, comment]);
      announce(t().commentAdded);
    },
  });

  const loadOlderComments = async (): Promise<boolean> => {
    const cursor = commentsCursor();
    if (!cursor || loadingOlderComments()) return false;
    const conversationId = props.conversationId;
    const request = ++commentsHistoryRequest;
    setLoadingOlderComments(true);
    try {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments.$get({
        param: { mailboxId: props.mailboxId, conversationId },
        query: { cursor, limit: "100", order: "newest" },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().loadCommentsFailed));
      const page = await response.json();
      if (request !== commentsHistoryRequest || conversationId !== props.conversationId) return false;
      const seen = new Set(comments().map((comment) => comment.id));
      setComments((current) => [...page.items.filter((comment) => !seen.has(comment.id)), ...current]);
      setCommentsCursor(page.nextCursor);
      commentsHistoryExtended = true;
      return true;
    } finally {
      if (request === commentsHistoryRequest) setLoadingOlderComments(false);
    }
  };

  const removeComment = mutations.create<string | null, ConversationComment>({
    mutation: async (comment, { abortSignal }) => {
      const conversationId = props.conversationId;
      const confirmed = await prompts.confirm(t().deletedAuditTrail, {
        title: t().deleteCommentTitle,
        confirmText: t().deleteComment,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted || conversationId !== props.conversationId) return null;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments[":commentId"].$delete(
        {
          param: {
            mailboxId: props.mailboxId,
            conversationId,
            commentId: comment.id,
          },
          json: { expectedRevision: comment.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().deleteCommentFailed));
      return comment.id;
    },
    // The note leaves the list together with the control that had focus, so a screen reader is told.
    onSuccess: (commentId) => {
      if (!commentId) return;
      setComments((current) => current.filter((comment) => comment.id !== commentId));
      announce(t().commentDeleted);
    },
    onError: (error) => toast.error(error.message),
  });

  type CommentEdit = { mailboxId: string; conversationId: string; comment: ConversationComment; body: string };
  const editComment = mutations.create<ConversationComment, CommentEdit, { edit: CommentEdit }>({
    onBefore: (edit) => ({ edit }),
    mutation: async ({ mailboxId, conversationId, comment, body }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments[":commentId"].$patch(
        {
          param: {
            mailboxId,
            conversationId,
            commentId: comment.id,
          },
          json: {
            expectedRevision: comment.revision,
            body,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().updateCommentFailed));
      return response.json();
    },
    // The note shows its new text; focus is back on its edit button, which does not say so.
    onSuccess: (updated) => {
      setComments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      announce(t().commentUpdated);
    },
    // The form has closed, so Retry saves the captured text again instead of losing it.
    onError: (error, context) =>
      retryToast(error.message, { retryLabel: t().retry, retry: () => context && editComment.mutate(context.edit) }),
  });
  const promptCommentEdit = async (comment: ConversationComment) => {
    const mailboxId = props.mailboxId;
    const conversationId = props.conversationId;
    const values = await prompts.form({
      title: t().editCommentTitle,
      icon: "ti ti-pencil",
      fields: {
        body: {
          type: "text",
          label: t().comment,
          default: comment.body ?? "",
          required: true,
          multiline: true,
          lines: 6,
          validate: (value) => (value?.trim() ? null : t().commentEmpty),
        },
      },
      confirmText: t().saveComment,
    });
    if (!values || disposed || mailboxId !== props.mailboxId || conversationId !== props.conversationId) return;
    await editComment.mutate({ mailboxId, conversationId, comment, body: String(values.body ?? "").trim() });
  };

  createEffect(
    on(
      () => props.conversationId,
      () => {
        commentsHistoryRequest++;
        setLoadingOlderComments(false);
        detailUpdates.reset();
        addComment.abort();
        removeComment.abort();
        editComment.abort();
        confirmedState = props.initialState;
        confirmedTagState = props.initialConversationLocalTags;
        confirmedReminder = props.initialReminder;
        setState(props.initialState);
        setAvailableTags(props.initialLocalTags);
        setTagState(props.initialConversationLocalTags);
        setComments(props.initialComments);
        setCommentsCursor(props.initialCommentsCursor);
        commentsHistoryExtended = false;
        setReminderDueAt(props.initialReminder?.state === "pending" ? props.initialReminder.dueAt : null);
        confirmedAvailableTagIds = new Set(props.initialLocalTags.map((tag) => tag.id));
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.initialState,
      (incoming) => {
        confirmedState = reconcileCollaboration(confirmedState, incoming);
        setState(applyCollaborationPatch(confirmedState, queuedCollaborationPatch(detailUpdates.pending())));
      },
    ),
  );
  createEffect(
    on(
      () => props.initialConversationLocalTags,
      (incoming) => {
        confirmedTagState = reconcileConversationTags(confirmedTagState, incoming);
        const pendingTags = queuedTagIds(detailUpdates.pending());
        setTagState(pendingTags ? applyTagIds(confirmedTagState, pendingTags) : confirmedTagState);
      },
    ),
  );
  createEffect(
    on(
      () => props.initialComments,
      (incoming) => {
        setComments((current) => reconcileComments(current, incoming));
        if (!commentsHistoryExtended) setCommentsCursor(props.initialCommentsCursor);
      },
    ),
  );
  createEffect(
    on(
      () => props.initialLocalTags,
      (incoming) => {
        setAvailableTags((current) => {
          const reconciled = reconcileAvailableTags(current, incoming, confirmedAvailableTagIds);
          confirmedAvailableTagIds = reconciled.confirmedIds;
          return reconciled.tags;
        });
      },
    ),
  );
  createEffect(
    on(
      () => props.initialReminder,
      (incoming) => {
        confirmedReminder = reconcileReminder(confirmedReminder, incoming);
        const pendingReminder = queuedReminderDueAt(detailUpdates.pending());
        setReminderDueAt(
          pendingReminder.pending ? pendingReminder.dueAt : confirmedReminder?.state === "pending" ? confirmedReminder.dueAt : null,
        );
      },
    ),
  );

  onCleanup(() => {
    disposed = true;
    createTagMutation.abort();
    addComment.abort();
    removeComment.abort();
    editComment.abort();
    detailUpdates.reset();
  });

  const related = createRelatedConversations({
    mailboxId: () => props.mailboxId,
    conversationId: () => props.conversationId,
    enabled: () => props.active && props.mailboxWide,
    failedLabel: () => t().loadRelatedFailed,
  });
  const detailPanelNone = () => details().noneYet;
  const commentItem = (comment: ConversationComment) => (
    <Discussion.Item
      avatar={
        <Avatar
          name={comment.author.displayName}
          src={comment.author.kind === "user" ? cloudAvatarSource(comment.author.id, comment.author.avatarHash) : undefined}
          icon={comment.author.kind === "workflow" ? "ti ti-route" : undefined}
          size="xs"
        />
      }
      author={comment.author.displayName}
      timestamp={
        <time dateTime={comment.createdAt} title={dates.formatDateTime(comment.createdAt, props.dateConfig)}>
          {dates.formatDateTimeRelative(comment.createdAt, props.dateConfig)}
        </time>
      }
      actions={
        <>
          <Show when={comment.canEdit}>
            <Tooltip.Anchor content={t().editComment}>
              <IconButton type="button" label={t().editComment} size="xs" onClick={() => void promptCommentEdit(comment)}>
                <i class="ti ti-pencil" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </Show>
          <Show when={comment.canDelete}>
            <Tooltip.Anchor content={t().deleteComment}>
              <IconButton type="button" label={t().deleteComment} size="xs" onClick={() => removeComment.mutate(comment)}>
                <i class="ti ti-trash" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </Show>
        </>
      }
    >
      <Show when={comment.body}>{(body) => <MarkdownView markdown={body()} headingScale="compact" />}</Show>
    </Discussion.Item>
  );
  const technicalDetails = () => (
    <>
      <DescriptionList
        layout="rows"
        size="sm"
        items={[
          {
            term: t().subject,
            description: (
              <span class="block truncate" title={props.subject}>
                {props.subject || t().noSubject}
              </span>
            ),
          },
          {
            term: t().from,
            description: (
              <span class="block truncate" title={addressList(latestMessage()?.from ?? [])}>
                {addressList(latestMessage()?.from ?? []) || t().unknown}
              </span>
            ),
          },
          {
            term: t().toLabel,
            description: (
              <span class="block truncate" title={addressList(latestMessage()?.to ?? [])}>
                {addressList(latestMessage()?.to ?? []) || t().undisclosed}
              </span>
            ),
          },
          {
            term: t().thread,
            description: t().messageCount({ count: props.messages.length }),
          },
          ...(attachmentCount() > 0
            ? [
                {
                  term: t().files,
                  description: t().attachmentCount({ count: attachmentCount() }),
                },
              ]
            : []),
          ...(latestMessage()?.messageId
            ? [
                {
                  term: t().messageId,
                  description: <span class="block truncate font-mono text-xs">{latestMessage()?.messageId}</span>,
                },
              ]
            : []),
          ...(latestMessage()
            ? [
                { term: t().size, description: formatFileViewSize(latestMessage()!.sizeBytes) },
                { term: t().content, description: latestMessage()!.contentType ?? t().unavailable },
                { term: t().mirror, description: latestMessage()!.hydrationStatus },
              ]
            : []),
        ]}
      />
      <Show when={latestMessage()}>
        {(message) => (
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-busy={inspectorLoading() === "headers" ? "true" : undefined}
              onClick={() => void openMessageInspector(message().id, "headers")}
            >
              <i class={inspectorLoading() === "headers" ? "ti ti-loader-2 animate-spin" : "ti ti-list-details"} aria-hidden="true" />{" "}
              {t().headers}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              aria-busy={inspectorLoading() === "source" ? "true" : undefined}
              onClick={() => void openMessageInspector(message().id, "source")}
            >
              <i class={inspectorLoading() === "source" ? "ti ti-loader-2 animate-spin" : "ti ti-code"} aria-hidden="true" /> {t().source}
            </Button>
            <Show when={cloudId.available()}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                data-mail-copy-cloud-id="message"
                onClick={() => cloudId.copy("message", message().id)}
              >
                <i class="ti ti-id" aria-hidden="true" /> {cloudId.t().copyMessage}
              </Button>
            </Show>
            <Show when={message().sourceAvailable}>
              <ButtonLink
                variant="secondary"
                size="sm"
                href={`/api/mail/mailboxes/${props.mailboxId}/messages/${message().id}/source`}
                download={`${message().subject.trim() || "message"}.eml`}
              >
                <i class="ti ti-download" aria-hidden="true" /> {t().downloadEml}
              </ButtonLink>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
  const details = createMemo(() => mailDetailsMessages.resolve([locale()]).t);
  const merged = createMemo(() => mergeMailAttachments(props.messages));
  const attachmentCount = () => merged().occurrences;
  const [arrangement, setArrangement] = createSignal<"files" | "messages">("files");
  const [packing, setPacking] = createSignal(false);
  const attachmentHref = (file: MailDetailFile) =>
    `/api/mail/mailboxes/${props.mailboxId}/messages/${file.messageId}/attachments/${file.attachment.id}`;
  const fileName = (file: MailDetailFile) => file.attachment.filename ?? t().untitledAttachment;
  const openFile = (file: MailDetailFile) => {
    const href = attachmentHref(file);
    if (canPreviewAttachment(file.attachment)) void openAttachmentPreview(file.attachment, href, `${href}?inline=true`);
    else downloadUrl(href, fileName(file));
  };
  const fileMeta = (file: MailDetailFile) =>
    [
      fileKindLabel({ name: fileName(file), mediaType: file.attachment.contentType }, locale()),
      formatFileViewSize(file.attachment.sizeBytes, locale()),
      file.from
        ? details().fromSender({ name: file.from })
        : file.messageIds.length > 1
          ? details().inMessages({ count: file.messageIds.length })
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
  // Packing belongs to the conversation it started in: leaving it or closing the panel stops the fetches.
  let packingAbort: AbortController | undefined;
  const stopPacking = () => {
    packingAbort?.abort();
    packingAbort = undefined;
    setPacking(false);
  };
  createEffect(on(() => props.conversationId, stopPacking, { defer: true }));
  onCleanup(stopPacking);
  const downloadAll = async () => {
    if (packing()) return;
    const controller = new AbortController();
    packingAbort = controller;
    setPacking(true);
    const files = merged().files.map((file) => ({ name: fileName(file), href: attachmentHref(file), size: file.attachment.sizeBytes }));
    const archiveName = `${props.subject.trim() || t().noSubject}.zip`;
    try {
      const zip = await importOnDemand(() => import("./mail-attachments-zip"));
      if (!zip || controller.signal.aborted) return;
      await zip.downloadMailAttachments(files, archiveName, controller.signal);
    } catch {
      if (!controller.signal.aborted) toast.error(details().downloadAllFailed);
    } finally {
      if (packingAbort === controller) {
        packingAbort = undefined;
        setPacking(false);
      }
    }
  };
  const messageLabel = (message: MailWorkspaceMessage) =>
    `${addressList(message.from) || t().unknownSender} · ${dates.formatDateTimeRelative(message.internalDate, props.dateConfig)}`;
  const propertyErrors = () =>
    props.detailErrors.collaboration || props.detailErrors.tags || props.detailErrors.assignableUsers || props.detailErrors.reminder;
  const done = () => state().workStatus === "done";
  const metaLine = () => {
    const latest = latestMessage();
    const line = details().meta({
      sender: addressList(latest?.from ?? []) || t().unknownSender,
      count: props.messages.length,
      latest: latest ? dates.formatDateTimeRelative(latest.internalDate, props.dateConfig) : "",
    });
    return props.canWrite ? line : `${line} · ${details().readOnlyMeta}`;
  };
  // Less frequent commands on the conversation; headers and source stay under "Technical details".
  const headerMenu = (): DropdownItem[] => [
    ...(props.conversationHref ? [{ label: t().openConversation, icon: "ti ti-arrow-up-right", href: props.conversationHref }] : []),
    ...(cloudId.available()
      ? [{ label: cloudId.t().copyConversation, icon: "ti ti-id", action: () => cloudId.copy("conversation", props.conversationId) }]
      : []),
  ];

  const attachmentsSection = () => (
    <DetailPanel.Section title={t().attachments} count={merged().files.length > 0 ? merged().files.length : undefined}>
      <Show when={merged().files.length > 0} fallback={<p class="mail-details-none">{details().noAttachments}</p>}>
        <FileGrid
          rows={merged().files}
          getRowId={(file) => file.key}
          label={t().attachments}
          layout="list"
          limit={5}
          actionVisibility="progressive"
          moreMeta={merged().merged > 0 ? details().duplicatesMerged({ count: merged().merged }) : undefined}
          toolbar={
            <>
              <span class="mail-details-files-info">
                {details().filesFromAttachments({ files: merged().files.length, attachments: merged().occurrences })}
                {merged().merged > 0 ? ` · ${details().duplicatesMerged({ count: merged().merged })}` : ""}
              </span>
              <SegmentedControl
                label={details().arrangement}
                size="sm"
                class="mail-details-arrangement"
                value={arrangement()}
                onValueChange={(value) => setArrangement(value === "messages" ? "messages" : "files")}
                options={[
                  { value: "files", label: details().byFile },
                  { value: "messages", label: details().byMessage },
                ]}
              />
              <span class="mail-details-files-bulk">
                <Tooltip.Anchor content={details().downloadAll({ count: merged().files.length })}>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={packing() ? details().downloadingAll : details().downloadAll({ count: merged().files.length })}
                    aria-busy={packing() || undefined}
                    onClick={() => void downloadAll()}
                  >
                    <i class={packing() ? "ti ti-loader-2 animate-spin" : "ti ti-download"} aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
                <SaveFilesButton
                  all
                  size="sm"
                  variant="ghost"
                  files={() => merged().files.map((file) => saveSource(file.attachment, attachmentHref(file)))}
                />
              </span>
            </>
          }
          groups={(rows) =>
            arrangement() === "messages"
              ? attachmentsByMessage(props.messages).map(({ message, files }) => ({
                  id: message.id,
                  label: messageLabel(message as MailWorkspaceMessage),
                  rows: files,
                }))
              : [
                  { id: "files", label: details().files, rows: rows.filter((file) => !isThumbnailImage(file.attachment)) },
                  {
                    id: "images",
                    label: details().images,
                    rows: rows.filter((file) => isThumbnailImage(file.attachment)),
                    layout: "tiles",
                  },
                ]
          }
          renderPreview={(file) =>
            isThumbnailImage(file.attachment) ? (
              <img src={`${attachmentHref(file)}?inline=true`} alt="" loading="lazy" decoding="async" />
            ) : (
              <FileTypeIcon name={fileName(file)} mediaType={file.attachment.contentType} />
            )
          }
          renderLabel={fileName}
          renderMeta={fileMeta}
          renderActions={(file) => (
            <>
              <Tooltip.Anchor content={mailMessageMessages.resolve([locale()]).t.downloadNamed({ name: fileName(file) })}>
                <IconButtonLink
                  size="sm"
                  variant="ghost"
                  href={attachmentHref(file)}
                  download={fileName(file)}
                  label={mailMessageMessages.resolve([locale()]).t.downloadNamed({ name: fileName(file) })}
                >
                  <i class="ti ti-download" aria-hidden="true" />
                </IconButtonLink>
              </Tooltip.Anchor>
              <SaveFilesButton size="sm" variant="ghost" files={() => [saveSource(file.attachment, attachmentHref(file))]} />
            </>
          )}
          onOpen={openFile}
        />
      </Show>
    </DetailPanel.Section>
  );

  const body = (parts?: MailContextParts) => (
    <>
      <Show when={props.conversationSummary?.summary}>
        {(summary) => (
          // ✦ and the AI ink only when the AI wrote the text (F3); a person's summary stays neutral.
          <div class="mail-details-summary" data-ai={props.conversationSummary?.ai ? "true" : undefined}>
            <Show when={props.conversationSummary?.ai}>
              <span class="mail-details-summary__origin">✦ {details().ai}</span>
            </Show>
            <MarkdownView markdown={summary()} headingScale="compact" class="mail-details-summary__text" />
          </div>
        )}
      </Show>

      <Show
        when={describeUnavailableMailDetails(
          {
            ...props.detailErrors,
            collaboration: null,
            tags: null,
            assignableUsers: null,
            reminder: null,
            comments: null,
            activity: null,
          },
          locale(),
        )}
      >
        {(description) => (
          <Placeholder state="error" variant="compact" align="left" title={description()} onRetry={() => void props.onReconcile()} />
        )}
      </Show>

      <Show when={props.canWrite && props.conversationDrafts[0]}>
        {(draft) => (
          <DetailPanel.Section
            title={t().draftsAvailable({ count: props.conversationDrafts.length })}
            count={props.conversationDrafts.length}
          >
            <DetailPanel.Action
              href={mailDraftHref(props.mailboxId, draft().id, props.requestUrl)}
              leading={<i class="ti ti-arrow-back-up" aria-hidden="true" />}
              title={t().continueDraft({ count: props.conversationDrafts.length })}
              description={t().draftMeta({
                name: draft().createdByDisplayName,
                updated: dates.formatDateTimeRelative(draft().updatedAt, props.dateConfig),
              })}
            />
          </DetailPanel.Section>
        )}
      </Show>

      <DetailPanel.Section
        title={details().properties}
        actions={
          <Show when={canAssign()}>
            <Tooltip.Anchor content={t().createTag}>
              <IconButton type="button" label={t().createTag} size="xs" onClick={() => void createTag()}>
                <i class="ti ti-tag-plus" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </Show>
        }
      >
        <Show when={propertyErrors()}>
          <Placeholder
            state="error"
            variant="compact"
            align="left"
            title={details().propertiesUnavailable}
            onRetry={() => void props.onReconcile()}
          />
        </Show>
        <DescriptionList
          layout="rows"
          size="sm"
          items={[
            {
              term: details().assigned,
              description: (
                <MultiSelectInput
                  aria-label={details().assigned}
                  appearance="plain"
                  value={() => state().assignees.map((user) => user.id)}
                  onValueChange={(userIds) => updateCollaboration({ assigneeUserIds: userIds })}
                  options={props.assignableUsers.map((user) => ({
                    id: user.id,
                    label: user.displayName,
                    description: user.description,
                    icon: "ti ti-user",
                  }))}
                  selectedOptions={() => state().assignees.map((user) => ({ id: user.id, label: user.displayName, icon: "ti ti-user" }))}
                  placeholder={details().nobody}
                  disabled={!canAssign() || Boolean(props.detailErrors.assignableUsers)}
                />
              ),
            },
            {
              term: t().tags,
              description: (
                <MultiSelectInput
                  aria-label={t().tags}
                  appearance="plain"
                  value={() => tagState().tags.map((tag) => tag.id)}
                  onValueChange={updateConversationTags}
                  options={availableTags().map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
                  selectedOptions={() => tagState().tags.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
                  placeholder={details().noTags}
                  disabled={!props.canWrite}
                />
              ),
            },
            {
              term: details().showLater,
              description: (
                <DateTimePicker
                  aria-label={details().showLater}
                  appearance="plain"
                  placeholder={details().notPlanned}
                  clearable
                  value={() => state().snoozedUntil}
                  onValueChange={(value) => updateCollaboration({ snoozedUntil: value || null })}
                  dateConfig={props.dateConfig}
                  disabled={!props.canWrite || done()}
                />
              ),
            },
            {
              term: details().reminder,
              description: (
                <span class="mail-details-reminder">
                  <DateTimePicker
                    aria-label={`${details().reminder}, ${details().onlyForYou}`}
                    appearance="plain"
                    placeholder={details().notSet}
                    clearable
                    value={reminderDueAt}
                    onValueChange={(value) => (value ? updateReminder(value) : clearReminder())}
                    dateConfig={props.dateConfig}
                    disabled={Boolean(props.detailErrors.reminder)}
                  />
                  <span class="mail-details-hint" aria-hidden="true">
                    {details().onlyForYou}
                  </span>
                </span>
              ),
            },
          ]}
        />
      </DetailPanel.Section>

      <Show when={parts}>
        {(context) => (
          <DetailPanel.Section
            title={details().linked}
            count={
              context().spacesCount() !== undefined && !related.loading() && !related.error()
                ? (context().spacesCount() ?? 0) + (related.data()?.length ?? 0) || undefined
                : undefined
            }
          >
            {context().spaces}
            <MailRelatedConversationsView
              mailboxId={props.mailboxId}
              items={related.data()}
              loading={related.loading()}
              error={related.error()?.message ?? null}
              unavailableText={details().relatedUnavailable}
              dateConfig={props.dateConfig}
              onRetry={() => void related.refresh()}
            />
            <Show
              when={
                context().spacesState() === "ready" &&
                context().spacesCount() === 0 &&
                !related.loading() &&
                !related.error() &&
                (related.data()?.length ?? 0) === 0
              }
            >
              <p class="mail-details-none">{detailPanelNone()}</p>
            </Show>
            {context().spacesAdd}
          </DetailPanel.Section>
        )}
      </Show>

      {attachmentsSection()}

      <Show when={props.conversationId} keyed>
        {(_conversationId) => (
          <Discussion label={details().teamNotes} count={commentsCursor() ? undefined : visibleComments().length}>
            <Discussion.List
              error={props.detailErrors.comments ? details().notesUnavailable : undefined}
              onRetry={props.onReconcile}
              fold={3}
              hasMore={commentsCursor() !== null}
              loadingMore={loadingOlderComments()}
              loadingLabel={t().loadingTeamNotes}
              loadMoreLabel={t().loadEarlierTeamNotes}
              onLoadMore={loadOlderComments}
            >
              <For each={visibleComments()}>{(comment) => commentItem(comment)}</For>
            </Discussion.List>

            <Show when={!props.detailErrors.comments}>
              <Discussion.Composer
                label={t().addInternalComment}
                placeholder={details().noteForTeam}
                submitLabel={t().postComment}
                onSubmit={async (body) => {
                  await addComment.mutate(body);
                  const error = addComment.error();
                  if (error) throw error;
                }}
              />
            </Show>
          </Discussion>
        )}
      </Show>

      <DetailPanel.Group title={details().moreAbout}>
        <Show when={parts?.showPeople()}>
          <DetailPanel.Section
            title={details().people}
            count={parts?.peopleNames().length || undefined}
            collapsible
            summary={parts?.peopleNames().join(" · ")}
          >
            {parts?.people}
          </DetailPanel.Section>
        </Show>
        <DetailPanel.Section
          title={details().activity}
          count={activityItems().length || undefined}
          collapsible
          summary={
            props.detailErrors.activity
              ? details().activityUnavailable
              : activityItems()[0]
                ? `${activityItems()[0]!.actorLabel} ${activityItems()[0]!.label}`
                : detailPanelNone()
          }
        >
          <Show
            when={!props.detailErrors.activity}
            fallback={
              <Placeholder
                state="error"
                variant="compact"
                align="left"
                title={details().activityUnavailable}
                onRetry={() => void props.onReconcile()}
              />
            }
          >
            <div class="mail-activity-rows">
              <For each={activityItems()}>
                {(event) => (
                  <div class="mail-activity-row">
                    <i
                      class={`ti ${event.outcome === "failed" ? "ti-alert-circle text-red-500" : `${event.icon} text-dimmed`}`}
                      aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1 truncate text-secondary">
                      <span class="font-medium text-primary">{event.actorLabel}</span> {event.label}
                      <Show when={event.count > 1}> ({event.count})</Show>
                    </span>
                    <time
                      class="shrink-0 text-xs text-dimmed"
                      dateTime={event.createdAt}
                      title={dates.formatDateTime(event.createdAt, props.dateConfig)}
                    >
                      {dates.formatDateTimeRelative(event.createdAt, props.dateConfig)}
                    </time>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </DetailPanel.Section>
        <DetailPanel.Section title={details().technicalDetails} collapsible summary={details().technicalSummary}>
          {technicalDetails()}
        </DetailPanel.Section>
      </DetailPanel.Group>
    </>
  );

  return (
    <div class="flex h-full min-h-0 flex-col focus:outline-none" data-mail-details-heading tabIndex={-1}>
      <DetailPanel>
        <DetailPanel.Header
          kind={
            <>
              <span>{details().kind}</span>
              <StatusBadge
                tone={done() ? "ok" : state().workStatus === "waiting" ? "neutral" : "warning"}
                label={done() ? t().done : state().workStatus === "waiting" ? t().waitingForReply : t().needsAction}
                icon={done() ? "ti ti-circle-check" : state().workStatus === "waiting" ? "ti ti-hourglass" : "ti ti-message-reply"}
              />
              <Show when={!props.canWrite}>
                <StatusBadge tone="neutral" icon="ti ti-lock" label={details().readOnly} />
              </Show>
            </>
          }
          title={props.subject || t().noSubject}
          subtitle={metaLine()}
          meta={
            <Show when={props.presence.some((participant) => participant.userId !== props.currentUserId)}>
              <AvatarStack
                people={props.presence.map((participant) => ({
                  id: participant.userId,
                  name: participant.displayName,
                  src: cloudAvatarSource(participant.userId, participant.avatarHash),
                  self: participant.userId === props.currentUserId,
                  detailIcon: participant.mode === "composing" ? "ti ti-pencil" : "ti ti-eye",
                  detail: participant.mode === "composing" ? t().composing : t().viewing,
                }))}
                title={t().activeCollaborators}
                label={`${t().activeCollaborators}: ${props.presence
                  .filter((participant) => participant.userId !== props.currentUserId)
                  .map((participant) => participant.displayName)
                  .join(", ")}`}
              />
            </Show>
          }
          primaryActions={
            props.canWrite ? (
              <Button
                size="sm"
                variant="subtle"
                class="mail-details-done"
                aria-pressed={done()}
                onClick={() => updateCollaboration({ completion: done() ? "open" : "done" })}
              >
                <i class={done() ? "ti ti-arrow-back-up" : "ti ti-circle-check"} aria-hidden="true" />
                {done() ? details().reopen : t().markDone}
              </Button>
            ) : undefined
          }
          menu={headerMenu()}
          actions={
            <Tooltip.Anchor content={t().closeDetails}>
              <IconButton
                type="button"
                class="@min-[64rem]/k2b-app-area:hidden"
                label={t().closeConversationDetails}
                onClick={props.onClose}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          }
        />

        <DetailPanel.Body scrollPreserveKey="mail-conversation-detail">
          <Show when={props.mailboxWide} fallback={body()}>
            <MailConversationContext
              subject={props.subject}
              mailboxId={props.mailboxId}
              conversationId={props.conversationId}
              requestUrl={props.requestUrl}
              active={props.active}
              canWrite={props.canWrite}
              createTaskLabel={details().createTask}
              moreLinkLabel={details().createTaskMore}
              unavailableText={details().linkedUnavailable}
            >
              {(parts) => body(parts)}
            </MailConversationContext>
          </Show>
        </DetailPanel.Body>
      </DetailPanel>
    </div>
  );
}
