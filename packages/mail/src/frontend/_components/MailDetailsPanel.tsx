import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Avatar,
  Button,
  ButtonLink,
  CheckboxCard,
  ColorInput,
  DateTimePicker,
  DescriptionList,
  DetailPanel,
  Discussion,
  formatFileViewSize,
  IconButton,
  MarkdownView,
  MultiSelectInput,
  Placeholder,
  prompts,
  Select,
  StatusBadge,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationDraftSummary } from "../../contracts";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "../../service/collaboration";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";
import type { MessageDetail } from "../../service/messages";
import type { ConversationPresenceParticipant } from "../../service/presence";
import type { ConversationReminder } from "../../service/reminders";
import type { MailDetailErrors } from "../../service/workspace";
import { readApiError } from "./api-response";
import MailConversationContext from "./MailConversationContext";
import { openMailMessageInspector } from "./MailMessageInspectorDialog";
import MailRelatedConversations from "./MailRelatedConversations";
import { presentMailActivity } from "./mail-activity-presentation";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { listUnavailableMailDetailSections } from "./mail-detail-availability";
import {
  applyMailCollaborationPatch,
  applyMailTagIds,
  createMailDetailUpdateQueue,
  type MailCollaborationPatch,
  queuedCollaborationPatch,
  queuedReminderDueAt,
  queuedTagIds,
} from "./mail-detail-update-queue";
import {
  reconcileAvailableTags,
  reconcileCollaboration,
  reconcileComments,
  reconcileConversationTags,
  reconcileReminder,
} from "./mail-details-reconciliation";

const avatarSource = (userId: string | undefined, avatarHash: string | null): string | undefined =>
  userId && avatarHash ? `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}` : undefined;

export default function MailDetailsPanel(props: {
  mailboxId: string;
  conversationId: string;
  active: boolean;
  canWrite: boolean;
  initialState: ConversationCollaboration;
  initialLocalTags: LocalTag[];
  initialConversationLocalTags: ConversationLocalTags;
  initialComments: ConversationComment[];
  initialCommentsCursor: string | null;
  assignableUsers: MailAssignableUser[];
  presence: ConversationPresenceParticipant[];
  activity: MailActivityEvent[];
  initialReminder: ConversationReminder | null;
  detailErrors: MailDetailErrors;
  conversationDrafts: ConversationDraftSummary[];
  conversationHref?: string;
  conversationSummary?: ConversationContentSummary | null;
  messages: MessageDetail[];
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
  const [state, setState] = createSignal(props.initialState);
  const [availableTags, setAvailableTags] = createSignal(props.initialLocalTags);
  const [tagState, setTagState] = createSignal(props.initialConversationLocalTags);
  const [comments, setComments] = createSignal(props.initialComments);
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
  const attachments = createMemo(() =>
    props.messages.flatMap((message) => message.attachments.map((attachment) => ({ ...attachment, messageId: message.id }))),
  );
  const attachmentCount = () => attachments().length;
  const activityItems = createMemo(() => presentMailActivity(props.activity, locale()));
  const visibleComments = createMemo(() => comments().filter((comment) => !comment.deletedAt));
  const unavailableSections = createMemo(() => listUnavailableMailDetailSections(props.detailErrors));
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
    onError: (error) => prompts.error(error.message),
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
    onSuccess: (comment) => {
      setComments((current) => [...current, comment]);
    },
    onError: (error) => prompts.error(error.message),
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
    onSuccess: (commentId) => {
      if (!commentId) return;
      setComments((current) => current.filter((comment) => comment.id !== commentId));
    },
    onError: (error) => prompts.error(error.message),
  });

  const editComment = mutations.create<ConversationComment | null, ConversationComment>({
    mutation: async (comment, { abortSignal }) => {
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
          },
        },
        confirmText: t().saveComment,
      });
      if (!values || abortSignal.aborted || conversationId !== props.conversationId) return null;
      const body = String(values.body ?? "").trim();
      if (!body) throw new Error(t().commentEmpty);
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].comments[":commentId"].$patch(
        {
          param: {
            mailboxId: props.mailboxId,
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
    onSuccess: (comment) => {
      if (!comment) return;
      setComments((current) => current.map((item) => (item.id === comment.id ? comment : item)));
      toast.success(t().commentUpdated);
    },
    onError: (error) => prompts.error(error.message),
  });

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
    createTagMutation.abort();
    addComment.abort();
    removeComment.abort();
    editComment.abort();
    detailUpdates.reset();
  });

  return (
    <div class="flex h-full min-h-0 flex-col focus:outline-none" data-mail-details-heading tabIndex={-1}>
      <DetailPanel>
        <DetailPanel.Header
          icon="ti ti-mail"
          title={props.subject || t().noSubject}
          subtitle={addressList(latestMessage()?.from ?? []) || t().unknownSender}
          meta={
            <StatusBadge
              tone={state().workStatus === "done" ? "ok" : state().workStatus === "waiting" ? "neutral" : "warning"}
              label={state().workStatus === "done" ? t().done : state().workStatus === "waiting" ? t().waitingForReply : t().needsAction}
              icon={
                state().workStatus === "done"
                  ? "ti ti-circle-check"
                  : state().workStatus === "waiting"
                    ? "ti ti-hourglass"
                    : "ti ti-message-reply"
              }
            />
          }
          primaryActions={
            props.conversationHref ? (
              <ButtonLink href={props.conversationHref} size="sm" variant="secondary">
                {t().openConversation} <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </ButtonLink>
            ) : undefined
          }
          actions={
            <Tooltip.Anchor content={t().closeDetails}>
              <IconButton type="button" class="lg:hidden" label={t().closeConversationDetails} onClick={props.onClose}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          }
        />

        <DetailPanel.Body scrollPreserveKey="mail-conversation-detail">
          <Show when={unavailableSections().length > 0}>
            <DetailPanel.Section title={t().detailAvailability} icon="ti ti-alert-circle" tone="danger">
              <Placeholder
                state="error"
                variant="compact"
                align="center"
                title={t().detailsTemporarilyUnavailable}
                description={t().unavailableSections({ sections: unavailableSections().join(", ") })}
                action={
                  <Button variant="secondary" size="sm" type="button" onClick={() => void props.onReconcile()}>
                    <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                  </Button>
                }
              />
            </DetailPanel.Section>
          </Show>

          <Show when={props.conversationSummary?.summary}>
            {(summary) => (
              <DetailPanel.Section title={t().conversationSummary} icon="ti ti-sparkles" tone="accent">
                <MarkdownView markdown={summary()} headingScale="compact" class="text-sm text-primary" />
              </DetailPanel.Section>
            )}
          </Show>

          <CheckboxCard
            label={t().markDone}
            description={t().markDoneDescription}
            icon="ti ti-circle-check"
            value={() => state().workStatus === "done"}
            onValueChange={(done) => updateCollaboration({ completion: done ? "done" : "open" })}
            disabled={!props.canWrite}
          />

          <Show when={props.canWrite && props.conversationDrafts[0]}>
            {(draft) => (
              <DetailPanel.Group label={t().draft}>
                <DetailPanel.Section
                  title={t().draftsAvailable({ count: props.conversationDrafts.length })}
                  icon="ti ti-file-pencil"
                  tone="accent"
                  meta={props.conversationDrafts.length}
                >
                  <DetailPanel.Action
                    href={mailDraftHref(props.mailboxId, draft().id, props.requestUrl)}
                    leading={<i class="ti ti-arrow-back-up" aria-hidden="true" />}
                    title={t().continueDraft({ count: props.conversationDrafts.length })}
                    description={t().draftMeta({
                      name: draft().createdByDisplayName,
                      updated: dates.formatDateTimeRelative(draft().updatedAt, props.dateConfig),
                    })}
                    trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                  />
                </DetailPanel.Section>
              </DetailPanel.Group>
            )}
          </Show>

          <DetailPanel.Group label={t().workflow}>
            <DetailPanel.Section
              title={t().workflow}
              actions={
                <Tooltip.Anchor content={t().createTag}>
                  <IconButton type="button" label={t().createTag} size="xs" disabled={!props.canWrite} onClick={() => void createTag()}>
                    <i class="ti ti-tag-plus" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              }
            >
              <div class="flex flex-col gap-2.5">
                <MultiSelectInput
                  label={t().tags}
                  value={() => tagState().tags.map((tag) => tag.id)}
                  onValueChange={updateConversationTags}
                  options={availableTags().map((tag) => ({
                    id: tag.id,
                    label: tag.name,
                    icon: "ti ti-tag",
                    color: tag.color,
                  }))}
                  selectedOptions={() =>
                    tagState().tags.map((tag) => ({
                      id: tag.id,
                      label: tag.name,
                      icon: "ti ti-tag",
                      color: tag.color,
                    }))
                  }
                  placeholder={t().selectTags}
                  clearable
                  disabled={!props.canWrite}
                />
                <Select
                  label={t().assignee}
                  value={() => state().assignee?.id ?? null}
                  selectedLabel={() => state().assignee?.displayName}
                  onValueChange={(userId) => updateCollaboration({ assigneeUserId: userId || null })}
                  options={props.assignableUsers.map((user) => ({
                    id: user.id,
                    label: user.displayName,
                    description: user.description,
                  }))}
                  clearable
                  disabled={!props.canWrite || Boolean(props.detailErrors.assignableUsers)}
                />
                <DateTimePicker
                  label={t().snoozeUntil}
                  value={() => state().snoozedUntil}
                  onValueChange={(value) => updateCollaboration({ snoozedUntil: value || null })}
                  dateConfig={props.dateConfig}
                  disabled={!props.canWrite || state().workStatus === "done"}
                />
                <div class="flex items-end gap-2">
                  <div class="min-w-0 flex-1">
                    <DateTimePicker
                      label={t().personalReminder}
                      value={reminderDueAt}
                      onValueChange={(value) => value && updateReminder(value)}
                      dateConfig={props.dateConfig}
                      disabled={Boolean(props.detailErrors.reminder)}
                    />
                  </div>
                  <Show when={reminderDueAt()}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      class="mb-0.5"
                      disabled={Boolean(props.detailErrors.reminder)}
                      onClick={clearReminder}
                    >
                      {t().clear}
                    </Button>
                  </Show>
                </div>
              </div>
            </DetailPanel.Section>
          </DetailPanel.Group>

          <DetailPanel.Group label={t().conversationContext}>
            <Show when={props.presence.length > 0}>
              <section aria-label={t().activeCollaborators} class="bg-[var(--ui-surface)] p-3">
                <div class="flex flex-col gap-2">
                  <For each={props.presence}>
                    {(participant) => (
                      <div class="flex items-center gap-2">
                        <Avatar name={participant.displayName} src={avatarSource(participant.userId, participant.avatarHash)} size="xs" />
                        <span class="min-w-0 flex-1 truncate text-sm text-primary">{participant.displayName}</span>
                        <StatusBadge
                          tone={participant.mode === "composing" ? "running" : "neutral"}
                          label={participant.mode === "composing" ? t().composing : t().viewing}
                          icon={participant.mode === "composing" ? "ti ti-pencil" : "ti ti-eye"}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <MailConversationContext
              mailboxId={props.mailboxId}
              conversationId={props.conversationId}
              requestUrl={props.requestUrl}
              active={props.active}
            />

            <MailRelatedConversations
              mailboxId={props.mailboxId}
              conversationId={props.conversationId}
              active={props.active}
              dateConfig={props.dateConfig}
            />

            <Show when={attachments().length > 0}>
              <DetailPanel.Section title={t().attachments} icon="ti ti-paperclip" tone="neutral" meta={attachments().length}>
                <div class="flex flex-col gap-1">
                  <For each={attachments()}>
                    {(attachment) => (
                      <DetailPanel.Action
                        href={`/api/mail/mailboxes/${props.mailboxId}/messages/${attachment.messageId}/attachments/${attachment.id}`}
                        download={attachment.filename ?? "attachment"}
                        leading={<i class="ti ti-paperclip" aria-hidden="true" />}
                        title={attachment.filename ?? attachment.contentType}
                        description={`${attachment.contentType} · ${formatFileViewSize(attachment.sizeBytes)}`}
                        trailing={<i class="ti ti-download" aria-hidden="true" />}
                      />
                    )}
                  </For>
                </div>
              </DetailPanel.Section>
            </Show>
          </DetailPanel.Group>

          <Show when={props.conversationId} keyed>
            {(_conversationId) => (
              <Discussion label={t().teamNotes} icon="ti ti-messages" count={commentsCursor() ? undefined : visibleComments().length}>
                <Discussion.List
                  error={props.detailErrors.comments}
                  onRetry={props.onReconcile}
                  hasMore={commentsCursor() !== null}
                  loadingMore={loadingOlderComments()}
                  loadingLabel={t().loadingTeamNotes}
                  loadMoreLabel={t().loadEarlierTeamNotes}
                  onLoadMore={loadOlderComments}
                >
                  <For each={visibleComments()}>
                    {(comment) => {
                      return (
                        <Discussion.Item
                          avatar={
                            <Avatar
                              name={comment.author.displayName}
                              src={avatarSource(comment.author.kind === "user" ? comment.author.id : undefined, comment.author.avatarHash)}
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
                                  <IconButton type="button" label={t().editComment} size="xs" onClick={() => editComment.mutate(comment)}>
                                    <i class="ti ti-pencil" aria-hidden="true" />
                                  </IconButton>
                                </Tooltip.Anchor>
                              </Show>
                              <Show when={comment.canDelete}>
                                <Tooltip.Anchor content={t().deleteComment}>
                                  <IconButton
                                    type="button"
                                    label={t().deleteComment}
                                    size="xs"
                                    onClick={() => removeComment.mutate(comment)}
                                  >
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
                    }}
                  </For>
                </Discussion.List>

                <Show when={!props.detailErrors.comments}>
                  <Discussion.Composer
                    label={t().addInternalComment}
                    placeholder={t().addInternalComment}
                    submitLabel={t().postComment}
                    onSubmit={async (body) => {
                      await addComment.mutate(body);
                      return addComment.error() === null;
                    }}
                  />
                </Show>
              </Discussion>
            )}
          </Show>

          <DetailPanel.Group label={t().conversationHistory}>
            <Show when={props.activity.length > 0}>
              <DetailPanel.Section title={t().recentActivity} icon="ti ti-history" tone="neutral" meta={activityItems().length} collapsible>
                <div class="flex flex-col gap-2">
                  <For each={activityItems()}>
                    {(event) => (
                      <div class="flex min-w-0 items-center gap-2 text-xs">
                        <i
                          class={`ti ${event.outcome === "failed" ? "ti-alert-circle text-red-500" : `${event.icon} text-dimmed`}`}
                          aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate text-secondary">
                          <span class="font-medium text-primary">{event.actorLabel}</span> {event.label}
                          <Show when={event.count > 1}> ({event.count})</Show>
                        </span>
                        <time class="shrink-0 text-xs text-dimmed" dateTime={event.createdAt}>
                          {dates.formatDateTimeRelative(event.createdAt, props.dateConfig)}
                        </time>
                      </div>
                    )}
                  </For>
                </div>
              </DetailPanel.Section>
            </Show>

            <DetailPanel.Section title={t().mailDetails} icon="ti ti-code" tone="neutral" collapsible>
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
                      onClick={() =>
                        void openMailMessageInspector({
                          mailboxId: props.mailboxId,
                          messages: props.messages,
                          initialMessageId: message().id,
                          initialTab: "headers",
                        })
                      }
                    >
                      <i class="ti ti-list-details" aria-hidden="true" /> {t().headers}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() =>
                        void openMailMessageInspector({
                          mailboxId: props.mailboxId,
                          messages: props.messages,
                          initialMessageId: message().id,
                          initialTab: "source",
                        })
                      }
                    >
                      <i class="ti ti-code" aria-hidden="true" /> {t().source}
                    </Button>
                    <Show when={message().sourceAvailable}>
                      <ButtonLink
                        variant="secondary"
                        size="sm"
                        href={`/api/mail/mailboxes/${props.mailboxId}/messages/${message().id}/source`}
                        download={`${message().subject.trim() || "message"}.eml`}
                      >
                        <i class="ti ti-download" aria-hidden="true" /> Download .eml
                      </ButtonLink>
                    </Show>
                  </div>
                )}
              </Show>
            </DetailPanel.Section>
          </DetailPanel.Group>
        </DetailPanel.Body>
      </DetailPanel>
    </div>
  );
}
