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
  const activityItems = createMemo(() => presentMailActivity(props.activity));
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
        if (!response.ok) throw new Error(await readApiError(response, "Failed to update conversation"));
        return { kind: "collaboration", value: await response.json() };
      }
      if (operation.kind === "tags") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"]["local-tags"].$put(
          { param, json: { expectedRevision: confirmedState.revision, tagIds: operation.tagIds } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, "Failed to update tags"));
        return { kind: "tags", value: await response.json() };
      }
      if (operation.kind === "reminder") {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$put(
          { param, json: { dueAt: operation.dueAt, expectedRevision: confirmedReminder?.revision ?? null } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, "Failed to set reminder"));
        return { kind: "reminder", value: await response.json() };
      }
      if (!confirmedReminder || confirmedReminder.state !== "pending") {
        throw new Error("No pending reminder is available to cancel.");
      }
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].reminder.$delete(
        { param, json: { expectedRevision: confirmedReminder.revision } },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to cancel reminder"));
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
      await prompts.error(error.message, { title: "Conversation changed" });
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to create tag"));
      return response.json();
    },
    onSuccess: (created) => {
      confirmedAvailableTagIds.add(created.id);
      setAvailableTags((current) =>
        [...current.filter((tag) => tag.id !== created.id), created].sort((left, right) => left.name.localeCompare(right.name)),
      );
      toast.success(`Created ${created.name}`);
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
            <TextInput label="Name" placeholder="Tag name" value={name} onValueChange={setName} required />
            <ColorInput label="Color" value={color} onValueChange={setColor} />
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" disabled={!name().trim()}>
                <i class="ti ti-tag-plus" aria-hidden="true" /> Create tag
              </Button>
            </div>
          </form>
        );
      },
      { title: "Create tag", icon: "ti ti-tag-plus" },
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to add comment"));
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to load earlier comments"));
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
      const confirmed = await prompts.confirm("The comment remains in the audit trail as deleted.", {
        title: "Delete internal comment?",
        confirmText: "Delete comment",
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to delete comment"));
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
        title: "Edit internal comment",
        icon: "ti ti-pencil",
        fields: {
          body: {
            type: "text",
            label: "Comment",
            default: comment.body ?? "",
            required: true,
            multiline: true,
            lines: 6,
          },
        },
        confirmText: "Save comment",
      });
      if (!values || abortSignal.aborted || conversationId !== props.conversationId) return null;
      const body = String(values.body ?? "").trim();
      if (!body) throw new Error("Comment cannot be empty");
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
      if (!response.ok) throw new Error(await readApiError(response, "Failed to update comment"));
      return response.json();
    },
    onSuccess: (comment) => {
      if (!comment) return;
      setComments((current) => current.map((item) => (item.id === comment.id ? comment : item)));
      toast.success("Comment updated");
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
          title={props.subject || "(no subject)"}
          subtitle={addressList(latestMessage()?.from ?? []) || "Unknown sender"}
          meta={
            <StatusBadge
              tone={state().workStatus === "done" ? "ok" : state().workStatus === "waiting" ? "neutral" : "warning"}
              label={state().workStatus === "done" ? "Done" : state().workStatus === "waiting" ? "Waiting for reply" : "Needs action"}
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
                Open conversation <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </ButtonLink>
            ) : undefined
          }
          actions={
            <Tooltip.Anchor content="Close details">
              <IconButton type="button" class="lg:hidden" label="Close conversation details" onClick={props.onClose}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          }
        />

        <DetailPanel.Body scrollPreserveKey="mail-conversation-detail">
          <Show when={unavailableSections().length > 0}>
            <DetailPanel.Section title="Detail availability" icon="ti ti-alert-circle" tone="danger">
              <Placeholder
                state="error"
                variant="compact"
                align="left"
                title="Some conversation details are temporarily unavailable"
                description={`Could not refresh ${unavailableSections().join(", ")}. Previously loaded values remain visible where available.`}
                action={
                  <Button variant="secondary" size="sm" type="button" onClick={() => void props.onReconcile()}>
                    <i class="ti ti-refresh" aria-hidden="true" /> Retry
                  </Button>
                }
              />
            </DetailPanel.Section>
          </Show>

          <Show when={props.conversationSummary?.summary}>
            {(summary) => (
              <DetailPanel.Section title="Conversation summary" icon="ti ti-sparkles" tone="accent">
                <MarkdownView markdown={summary()} headingScale="compact" class="text-sm text-primary" />
              </DetailPanel.Section>
            )}
          </Show>

          <CheckboxCard
            label="Mark as done"
            description="No further follow-up is needed."
            icon="ti ti-circle-check"
            value={() => state().workStatus === "done"}
            onValueChange={(done) => updateCollaboration({ completion: done ? "done" : "open" })}
            disabled={!props.canWrite}
          />

          <Show when={props.canWrite && props.conversationDrafts[0]}>
            {(draft) => (
              <DetailPanel.Group label="Draft">
                <DetailPanel.Section
                  title={props.conversationDrafts.length === 1 ? "Draft available" : "Drafts available"}
                  icon="ti ti-file-pencil"
                  tone="accent"
                  meta={props.conversationDrafts.length}
                >
                  <DetailPanel.Action
                    href={mailDraftHref(props.mailboxId, draft().id, props.requestUrl)}
                    leading={<i class="ti ti-arrow-back-up" aria-hidden="true" />}
                    title={props.conversationDrafts.length === 1 ? "Continue draft" : "Continue newest draft"}
                    description={`Created by ${draft().createdByDisplayName} · Updated ${dates.formatDateTimeRelative(draft().updatedAt, props.dateConfig)}`}
                    trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                  />
                </DetailPanel.Section>
              </DetailPanel.Group>
            )}
          </Show>

          <DetailPanel.Group label="Workflow">
            <DetailPanel.Section
              title="Workflow"
              actions={
                <Tooltip.Anchor content="Create tag">
                  <IconButton type="button" label="Create tag" size="xs" disabled={!props.canWrite} onClick={() => void createTag()}>
                    <i class="ti ti-tag-plus" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              }
            >
              <div class="flex flex-col gap-2.5">
                <MultiSelectInput
                  label="Tags"
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
                  placeholder="Select tags"
                  clearable
                  disabled={!props.canWrite}
                />
                <Select
                  label="Assignee"
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
                  label="Snooze until"
                  value={() => state().snoozedUntil}
                  onValueChange={(value) => updateCollaboration({ snoozedUntil: value || null })}
                  dateConfig={props.dateConfig}
                  disabled={!props.canWrite || state().workStatus === "done"}
                />
                <div class="flex items-end gap-2">
                  <div class="min-w-0 flex-1">
                    <DateTimePicker
                      label="Personal reminder"
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
                      Clear
                    </Button>
                  </Show>
                </div>
              </div>
            </DetailPanel.Section>
          </DetailPanel.Group>

          <DetailPanel.Group label="Conversation context">
            <Show when={props.presence.length > 0}>
              <section aria-label="Active collaborators" class="bg-[var(--ui-surface)] p-3">
                <div class="flex flex-col gap-2">
                  <For each={props.presence}>
                    {(participant) => (
                      <div class="flex items-center gap-2">
                        <Avatar name={participant.displayName} src={avatarSource(participant.userId, participant.avatarHash)} size="xs" />
                        <span class="min-w-0 flex-1 truncate text-sm text-primary">{participant.displayName}</span>
                        <StatusBadge
                          tone={participant.mode === "composing" ? "running" : "neutral"}
                          label={participant.mode === "composing" ? "Composing" : "Viewing"}
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
              <DetailPanel.Section title="Attachments" icon="ti ti-paperclip" tone="neutral" meta={attachments().length}>
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
              <Discussion label="Team notes" icon="ti ti-messages" count={commentsCursor() ? undefined : visibleComments().length}>
                <Discussion.List
                  error={props.detailErrors.comments}
                  onRetry={props.onReconcile}
                  hasMore={commentsCursor() !== null}
                  loadingMore={loadingOlderComments()}
                  loadingLabel="Loading team notes"
                  loadMoreLabel="Load earlier team notes"
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
                                <Tooltip.Anchor content="Edit comment">
                                  <IconButton type="button" label="Edit comment" size="xs" onClick={() => editComment.mutate(comment)}>
                                    <i class="ti ti-pencil" aria-hidden="true" />
                                  </IconButton>
                                </Tooltip.Anchor>
                              </Show>
                              <Show when={comment.canDelete}>
                                <Tooltip.Anchor content="Delete comment">
                                  <IconButton type="button" label="Delete comment" size="xs" onClick={() => removeComment.mutate(comment)}>
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
                    label="Add internal comment"
                    placeholder="Add internal comment"
                    submitLabel="Post comment"
                    onSubmit={async (body) => {
                      await addComment.mutate(body);
                      return addComment.error() === null;
                    }}
                  />
                </Show>
              </Discussion>
            )}
          </Show>

          <DetailPanel.Group label="Conversation history">
            <Show when={props.activity.length > 0}>
              <DetailPanel.Section title="Recent activity" icon="ti ti-history" tone="neutral" meta={activityItems().length} collapsible>
                <div class="flex flex-col gap-2">
                  <For each={activityItems()}>
                    {(event) => (
                      <div class="flex min-w-0 items-center gap-2 text-xs">
                        <i
                          class={`ti ${event.outcome === "failed" ? "ti-alert-circle text-red-500" : "ti-circle-check text-dimmed"}`}
                          aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate text-secondary">
                          <span class="font-medium text-primary">{event.actor.displayName}</span> {event.label}
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

            <DetailPanel.Section title="Mail details" icon="ti ti-code" tone="neutral" collapsible>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  {
                    term: "Subject",
                    description: (
                      <span class="block truncate" title={props.subject}>
                        {props.subject || "(no subject)"}
                      </span>
                    ),
                  },
                  {
                    term: "From",
                    description: (
                      <span class="block truncate" title={addressList(latestMessage()?.from ?? [])}>
                        {addressList(latestMessage()?.from ?? []) || "Unknown"}
                      </span>
                    ),
                  },
                  {
                    term: "To",
                    description: (
                      <span class="block truncate" title={addressList(latestMessage()?.to ?? [])}>
                        {addressList(latestMessage()?.to ?? []) || "Undisclosed"}
                      </span>
                    ),
                  },
                  {
                    term: "Thread",
                    description: `${props.messages.length} message${props.messages.length === 1 ? "" : "s"}`,
                  },
                  ...(attachmentCount() > 0
                    ? [
                        {
                          term: "Files",
                          description: `${attachmentCount()} attachment${attachmentCount() === 1 ? "" : "s"}`,
                        },
                      ]
                    : []),
                  ...(latestMessage()?.messageId
                    ? [
                        {
                          term: "Message ID",
                          description: <span class="block truncate font-mono text-xs">{latestMessage()?.messageId}</span>,
                        },
                      ]
                    : []),
                  ...(latestMessage()
                    ? [
                        { term: "Size", description: formatFileViewSize(latestMessage()!.sizeBytes) },
                        { term: "Content", description: latestMessage()!.contentType ?? "Unavailable" },
                        { term: "Mirror", description: latestMessage()!.hydrationStatus },
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
                      <i class="ti ti-list-details" aria-hidden="true" /> Headers
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
                      <i class="ti ti-code" aria-hidden="true" /> Source
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
