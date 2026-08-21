import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { dropzone, mutation as mutations, query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  type Completion,
  Dropdown,
  type DropdownItem,
  IconButton,
  isPanesItemVisible,
  NoticeCard,
  type PanesLayout,
  prompts,
  Select,
  SplitButton,
  TextInput,
  Tooltip,
  toast,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  ComposePreview,
  ComposeSafetyApproval,
  ComposeSafetyReview,
  DraftEditableContent,
  DraftEditableContentInput,
  DraftIntent,
  DraftRecoveryCopy,
  MailCommand,
  MailDraft,
  MailDraftSeed,
  MailPriority,
  SenderIdentity,
} from "../../contracts";
import { readApiError } from "./api-response";
import MailComposerAttachments from "./MailComposerAttachments";
import { openMailComposerCalendarDialog } from "./MailComposerCalendarDialog";
import MailComposerEditor from "./MailComposerEditor";
import MailComposerHistory from "./MailComposerHistory";
import MailComposerLifecycleNotice from "./MailComposerLifecycleNotice";
import { mailDraftCollaborationCopy, openMailDraftCollaborationDialog } from "./MailDraftCollaborationDialog";
import MailRecipientInput from "./MailRecipientInput";
import { chooseScheduledSendTime } from "./MailScheduleDialog";
import { readMailUserPreferences, writeMailComposerPanes } from "./MailSettingsStore";
import { launchMailDraftAssistant } from "./mail-assistant-launch";
import { mailConversationHref, mailDraftHref, mailDraftSeedHref } from "./mail-compose-route";
import { createMailComposerAttachmentManager } from "./mail-composer-attachment-manager";
import { focusMailComposerEditorAtStart } from "./mail-composer-editor-focus";
import { reconcileMailComposerPanes } from "./mail-composer-panes";
import { createMailComposerTransition } from "./mail-composer-transition";
import { removeMailDraftSeed } from "./mail-draft-seed-store";
import { createMailDraftSession } from "./mail-draft-session";
import { formatMailRecipients, parseMailRecipients } from "./mail-recipient";
import { writeMailSenderPreference } from "./mail-sender-preference";

class ComposeSafetyCancelled extends Error {}
class ComposeSafetyAttachmentRequested extends Error {}

const intentLabel = (intent: DraftIntent): string =>
  intent === "reply" ? "Reply" : intent === "reply_all" ? "Reply all" : intent === "forward" ? "Forward" : "Send";

const intentIcon = (intent: DraftIntent): string =>
  intent === "reply"
    ? "ti-arrow-back-up"
    : intent === "reply_all"
      ? "ti-arrow-back-up-double"
      : intent === "forward"
        ? "ti-arrow-forward-up"
        : "ti-send";

export default function MailComposer(props: {
  mailboxId: string;
  currentActor: { kind: "user" | "service_account"; id: string };
  identities: SenderIdentity[];
  initialDraft?: MailDraft;
  initialSeed?: MailDraftSeed;
  initialPanes: PanesLayout;
  popout?: boolean;
  returnHref: string;
  dateConfig: DateContext;
  canShareAttachments?: boolean;
  calendarIntegrationAvailable?: boolean;
}) {
  const initial = props.initialDraft ?? props.initialSeed;
  if (!initial) throw new Error("MailComposer requires a draft or compose seed");
  const initialContent = props.initialDraft
    ? {
        senderIdentityId: props.initialDraft.senderIdentityId,
        to: props.initialDraft.to,
        cc: props.initialDraft.cc,
        bcc: props.initialDraft.bcc,
        subject: props.initialDraft.subject,
        body: props.initialDraft.body,
        format: props.initialDraft.format,
        priority: props.initialDraft.priority,
        requestDeliveryReceipt: props.initialDraft.requestDeliveryReceipt,
        requestReadReceipt: props.initialDraft.requestReadReceipt,
      }
    : props.initialSeed!.content;
  let attachmentInput: HTMLInputElement | undefined;
  let initialEditorFocusApplied = false;
  const verifiedIdentities = () => props.identities.filter((identity) => identity.status === "verified");
  const preferences = readMailUserPreferences(props.mailboxId);
  const [identityId, setIdentityId] = createSignal(initialContent.senderIdentityId);
  const selectedIdentity = () => verifiedIdentities().find((identity) => identity.id === identityId()) ?? null;
  const identityMenuItems = createMemo<DropdownItem[]>(() =>
    verifiedIdentities().map((identity) => ({
      icon: identity.id === identityId() ? "ti ti-check" : "ti ti-user",
      label: `${identity.label} · ${identity.fromAddress}`,
      action: () => {
        setIdentityId(identity.id);
        writeMailSenderPreference(localStorage, props.mailboxId, identity.id);
      },
    })),
  );
  const [to, setTo] = createSignal(formatMailRecipients(initialContent.to));
  const [cc, setCc] = createSignal(formatMailRecipients(initialContent.cc));
  const [bcc, setBcc] = createSignal(formatMailRecipients(initialContent.bcc));
  const [subject, setSubject] = createSignal(initialContent.subject);
  const [body, setBody] = createSignal(initialContent.body);
  const [format, setFormat] = createSignal<"plain" | "markdown">(initialContent.format);
  const [priority, setPriority] = createSignal(initialContent.priority);
  const [requestDeliveryReceipt, setRequestDeliveryReceipt] = createSignal(initialContent.requestDeliveryReceipt);
  const [requestReadReceipt, setRequestReadReceipt] = createSignal(initialContent.requestReadReceipt);
  const deliveryOptionsSummary = createMemo(() => {
    const options: string[] = [];
    if (priority() === "high") options.push("high priority");
    if (priority() === "low") options.push("low priority");
    if (requestDeliveryReceipt()) options.push("delivery receipt");
    if (requestReadReceipt()) options.push("read receipt");
    return options;
  });
  const [showCc, setShowCc] = createSignal(Boolean(initialContent.cc.length || initialContent.bcc.length));
  const [composerPanes, setComposerPanes] = createSignal(
    reconcileMailComposerPanes(props.initialPanes, initialContent.format, Boolean(initial.conversationId)),
  );
  const composerTransition = createMailComposerTransition();
  let recoveryController: AbortController | null = null;
  let disposed = false;
  let panePersistenceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearInitialSeed = () => {
    if (!props.initialSeed) return;
    try {
      removeMailDraftSeed(localStorage, props.mailboxId, props.initialSeed.id);
    } catch {
      // Expired local seed cleanup must never block leaving the composer.
    }
  };

  const content = (): DraftEditableContent => ({
    senderIdentityId: identityId(),
    to: parseMailRecipients(to()),
    cc: parseMailRecipients(cc()),
    bcc: parseMailRecipients(bcc()),
    subject: subject(),
    body: body(),
    format: format(),
    priority: priority(),
    requestDeliveryReceipt: requestDeliveryReceipt(),
    requestReadReceipt: requestReadReceipt(),
  });

  const applyDraftContent = (value: DraftEditableContent) => {
    setIdentityId(value.senderIdentityId);
    setTo(formatMailRecipients(value.to));
    setCc(formatMailRecipients(value.cc));
    setBcc(formatMailRecipients(value.bcc));
    setShowCc(Boolean(value.cc.length || value.bcc.length));
    setSubject(value.subject);
    setBody(value.body);
    setFormat(value.format);
    setPriority(value.priority);
    setRequestDeliveryReceipt(value.requestDeliveryReceipt);
    setRequestReadReceipt(value.requestReadReceipt);
  };
  const draftSession = createMailDraftSession({
    mailboxId: props.mailboxId,
    initialDraft: props.initialDraft,
    initialSeed: props.initialSeed,
    hasVerifiedIdentity: () => verifiedIdentities().length > 0,
    content,
    applyDraftContent,
    isDisposed: () => disposed,
    onRecovered: () => toast("Unsaved changes from this browser were restored.", { title: "Draft recovered" }),
    onMaterialized: (materialized) => {
      if (props.initialSeed) {
        clearInitialSeed();
        window.history.replaceState(
          window.history.state,
          "",
          mailDraftHref(props.mailboxId, materialized.id, props.returnHref, {
            popout: props.popout,
          }),
        );
      }
    },
  });
  const {
    draft,
    setDraft,
    lease,
    leaseConflict,
    lifecycleTransition,
    status,
    setStatus,
    statusMessage,
    setStatusMessage,
    persist,
    serializeMutation: serializeDraftMutation,
    stopScheduledSave,
    stopHeartbeat,
    acquireLease,
    releaseLease,
    releaseLeaseOnExit,
    resumeCurrentLease,
    hasUnsavedChanges,
  } = draftSession;
  const conversationId = () => draft()?.conversationId ?? initial.conversationId;
  const composeWithAi = mutations.create<void, void>({
    mutation: async () => {
      const currentDraft = await persist();
      if (!currentDraft) throw new Error(statusMessage() || "Draft could not be saved");
      const launch = await launchMailDraftAssistant({
        mailboxId: props.mailboxId,
        returnHref: props.returnHref,
        draft: currentDraft,
      });
      navigateTo(launch.href);
    },
  });
  const saveLifecycleCopy = mutations.create<MailDraft, void>({
    mutation: async () => {
      const response = await apiClient.mailboxes[":mailboxId"].drafts.$post({
        param: { mailboxId: props.mailboxId },
        json: {
          ...content(),
          conversationId: null,
          intent: "new",
          sourceMessageId: null,
          includeSourceAttachments: false,
        },
      });
      if (!response.ok) throw new Error(await readApiError(response, "Could not save as a new draft"));
      return await response.json();
    },
    onSuccess: (created) => navigateTo(mailDraftHref(props.mailboxId, created.id, props.returnHref, { popout: props.popout })),
    onError: (error) => prompts.error(error.message),
  });
  const copyLifecycleText = async () => {
    try {
      await navigator.clipboard.writeText(body());
      toast.success("Unsaved text copied");
    } catch {
      await prompts.error("Your browser could not copy the text. The read-only editor still contains it.");
    }
  };
  const openLifecycleMessage = () => {
    const current = lifecycleTransition()?.draft;
    if (!current?.conversationId) return;
    const target = new URL(props.returnHref, window.location.origin);
    target.searchParams.set("conversation", current.conversationId);
    navigateTo(`${target.pathname}${target.search}${target.hash}`);
  };
  const currentComposerPanes = createMemo(() => reconcileMailComposerPanes(composerPanes(), format(), Boolean(conversationId())));
  type PreviewInput = { draft: DraftEditableContentInput; conversationId: string | null };
  const initialPreviewInput: PreviewInput = { draft: content(), conversationId: conversationId() };
  const [previewSource, setPreviewSource] = createSignal(JSON.stringify(initialPreviewInput));
  const previewQuery = query.create<string, ComposePreview>({
    source: previewSource,
    enabled: () => format() === "markdown" && isPanesItemVisible(currentComposerPanes(), "preview") && Boolean(identityId()),
    load: async (serialized, { abortSignal }) => {
      const input = JSON.parse(serialized) as PreviewInput;
      const response = await apiClient.mailboxes[":mailboxId"]["compose-preview"].$post(
        {
          param: { mailboxId: props.mailboxId },
          json: input,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Preview could not be rendered"));
      return await response.json();
    },
  });
  const previewDebounce = timed.debounce((serialized: string) => setPreviewSource(serialized), 150);
  const stopPreview = () => previewDebounce.cancel();
  const preview = () => previewQuery.data() ?? null;
  const canEditDraft = createMemo(
    () => verifiedIdentities().length > 0 && status() !== "preparing" && status() !== "readonly" && (Boolean(lease()) || !draft()),
  );
  const editable = createMemo(() => canEditDraft() && composerTransition.active() === null);
  const focusFreshEditorAtStart = (element: HTMLTextAreaElement) => {
    if (!props.initialSeed || initialEditorFocusApplied) return;
    queueMicrotask(() => {
      if (initialEditorFocusApplied || disposed || !editable() || !element.isConnected) return;
      initialEditorFocusApplied = true;
      focusMailComposerEditorAtStart(element);
    });
  };
  const attachments = createMailComposerAttachmentManager({
    mailboxId: props.mailboxId,
    draft,
    initialAttachments: () => props.initialSeed?.attachments ?? [],
    setDraft,
    editable,
    persist,
    serializeDraftMutation,
    transition: composerTransition,
    format,
    setBody,
    isDisposed: () => disposed,
  });
  const uploads = attachments.uploads;
  const attachmentDropzone = dropzone.create({
    onDrop: (files) => {
      if (!editable() || files.length === 0) return;
      void attachments.addFiles(files);
    },
  });

  const addCalendarInvitation = async () => {
    const reservation = composerTransition.reserve("calendar");
    if (!reservation) return;
    try {
      const currentDraft = await persist();
      if (!currentDraft) throw new Error(statusMessage());
      const updated = await openMailComposerCalendarDialog({
        mailboxId: props.mailboxId,
        draftId: currentDraft.id,
        recipientCount: parseMailRecipients(to()).length + parseMailRecipients(cc()).length,
        dateConfig: props.dateConfig,
      });
      if (updated) {
        setDraft(updated);
        toast("The invitation was attached to this draft.", { title: "Calendar invitation added" });
      }
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Calendar invitation could not be added");
    } finally {
      composerTransition.release(reservation);
    }
  };

  const updateComposerPanes = (value: PanesLayout) => {
    setComposerPanes(value);
    if (panePersistenceTimer) clearTimeout(panePersistenceTimer);
    panePersistenceTimer = setTimeout(() => {
      setComposerPanes(writeMailComposerPanes(value));
      panePersistenceTimer = null;
    }, 150);
  };

  createEffect(() => {
    const current = composerPanes();
    const next = currentComposerPanes();
    if (next !== current) updateComposerPanes(next);
  });

  createEffect(() => {
    if (!lifecycleTransition()) return;
    deliveryPreparationController?.abort();
    deliveryPreparationController = null;
    send.abort();
    discard.abort();
    saveLifecycleCopy.abort();
  });

  const restoreRecoveryCopy = async () => {
    const currentDraft = draft();
    if (!currentDraft || !editable()) return;
    const reservation = composerTransition.reserve("recovery");
    if (!reservation) return;
    recoveryController?.abort();
    const controller = new AbortController();
    recoveryController = controller;
    try {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["recovery-copies"].$get(
        { param: { mailboxId: props.mailboxId, draftId: currentDraft.id } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Could not load draft recovery copies"));
      const copies: DraftRecoveryCopy[] = await response.json();
      if (disposed || recoveryController !== controller) return;
      const unresolved = copies.filter((copy) => !copy.restoredAt);
      if (unresolved.length === 0) {
        setDraft({ ...currentDraft, recoveryCopyCount: 0 });
        return void toast("No unresolved recovery copies remain.", { title: "Draft is current" });
      }
      const labels = new Map(
        unresolved.map((copy, index) => {
          const preview = copy.content.body.trim().replaceAll(/\s+/g, " ").slice(0, 80) || "(empty message)";
          return [
            copy.id,
            `${index + 1}. ${dates.formatDateTimeRelative(copy.createdAt, props.dateConfig)} · ${copy.createdBy.kind} · ${preview}`,
          ];
        }),
      );
      const values = await prompts.form({
        title: "Restore draft changes",
        fields: {
          recoveryCopyId: {
            type: "select",
            label: "Recovery copy",
            options: unresolved.map((copy) => ({ id: copy.id, label: labels.get(copy.id) ?? copy.id })),
            default: unresolved[0]?.id,
            required: true,
          },
        },
        confirmText: "Restore copy",
      });
      if (!values || disposed || recoveryController !== controller) return;
      const selected = unresolved.find((copy) => copy.id === values.recoveryCopyId);
      if (!selected) return void (await prompts.error("The selected recovery copy is no longer available."));
      const currentLease = lease();
      if (!canEditDraft() || !currentLease) return void (await prompts.error("This draft is no longer editable in this session."));
      const restoreResponse = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["recovery-copies"][
        ":recoveryCopyId"
      ].restore.$post(
        {
          param: {
            mailboxId: props.mailboxId,
            draftId: currentDraft.id,
            recoveryCopyId: selected.id,
          },
          json: { expectedRevision: currentDraft.revision, leaseToken: currentLease.token },
        },
        { init: { signal: controller.signal } },
      );
      if (!restoreResponse.ok) throw new Error(await readApiError(restoreResponse, "Could not restore draft changes"));
      const restored = await restoreResponse.json();
      if (disposed || recoveryController !== controller) return;
      setDraft(restored);
      applyDraftContent(restored);
      draftSession.markCurrentContentSaved();
      localStorage.removeItem(draftSession.draftKey(restored.id));
      setStatus("saved");
      setStatusMessage("");
      toast.success("Draft changes restored");
    } catch (error) {
      if (!disposed && recoveryController === controller && !(error instanceof DOMException && error.name === "AbortError")) {
        await prompts.error(error instanceof Error ? error.message : "Could not restore draft changes");
      }
    } finally {
      if (recoveryController === controller) recoveryController = null;
      composerTransition.release(reservation);
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const serialized = JSON.stringify({ draft: content(), conversationId: conversationId() } satisfies PreviewInput);
    if (format() !== "markdown" || !identityId()) {
      stopPreview();
      return;
    }
    if (!isPanesItemVisible(currentComposerPanes(), "preview")) {
      stopPreview();
      setPreviewSource(serialized);
      return;
    }
    if (previewSource() === serialized) {
      stopPreview();
      return;
    }
    previewDebounce.debouncedFn(serialized);
  });

  onCleanup(() => {
    disposed = true;
    recoveryController?.abort();
    recoveryController = null;
    stopPreview();
    previewQuery.abort();
    if (panePersistenceTimer) {
      clearTimeout(panePersistenceTimer);
      writeMailComposerPanes(composerPanes());
    }
  });

  const validateDelivery = () => {
    if (uploads().length > 0) throw new Error("Finish or cancel attachment uploads before sending.");
    if (to().length + cc().length + bcc().length === 0) throw new Error("Add at least one recipient.");
    if (!body().trim() && !(draft()?.attachments.length ?? props.initialSeed?.attachments.length ?? 0)) {
      throw new Error("Write a message or attach a file before sending.");
    }
  };

  const reviewSafety = async (
    saved: MailDraft,
    scheduled: boolean,
    abortSignal: AbortSignal,
  ): Promise<ComposeSafetyApproval | undefined> => {
    const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["safety-review"].$post(
      {
        param: { mailboxId: props.mailboxId, draftId: saved.id },
        json: { expectedRevision: saved.revision },
      },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, "Could not review message safety"));
    const review: ComposeSafetyReview = await response.json();
    if (review.warnings.length === 0) return undefined;
    const choice = await prompts.dialog<"approve" | "attachment">(
      (close) => (
        <div class="flex flex-col gap-3">
          <div class="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
            <For each={review.warnings}>
              {(warning) => (
                <div class="flex items-start gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3">
                  <i class="ti ti-alert-triangle mt-0.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-primary">{warning.title}</p>
                    <p class="mt-1 text-xs leading-5 text-secondary">{warning.description}</p>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              Cancel
            </Button>
            <Show when={review.warnings.some((warning) => warning.id === "missing_attachment")}>
              <Button variant="secondary" size="sm" type="button" onClick={() => close("attachment")}>
                <i class="ti ti-paperclip" aria-hidden="true" /> Add attachment
              </Button>
            </Show>
            <Button size="sm" type="button" onClick={() => close("approve")}>
              {scheduled ? "Schedule anyway" : "Send anyway"}
            </Button>
          </div>
        </div>
      ),
      { title: "Review before sending", icon: "ti ti-shield-check", size: "medium" },
    );
    if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
    if (choice === "attachment") throw new ComposeSafetyAttachmentRequested();
    if (choice !== "approve") throw new ComposeSafetyCancelled();
    return {
      revision: review.revision,
      fingerprint: review.fingerprint,
      warningIds: review.warnings.map((warning) => warning.id),
    };
  };

  type PreparedDelivery = {
    scheduledAt?: string;
    contentFingerprint: string;
    draftId: string;
    request: {
      kind: "send";
      draftId: string;
      expectedDraftRevision: number;
      senderIdentityId: string;
      scheduledAt?: string;
      undoSeconds: number;
      safetyApproval?: ComposeSafetyApproval;
      idempotencyKey: string;
    };
  };
  let attachAfterDeliveryReview = false;
  let lastDeliveryAttempt: PreparedDelivery | null = null;
  let deliveryPreparationController: AbortController | null = null;
  const deliveryFingerprint = (delivery: { scheduledAt?: string }) =>
    JSON.stringify({
      content: content(),
      scheduledAt: delivery.scheduledAt,
      undoSeconds: delivery.scheduledAt ? 0 : preferences.undoSeconds,
    });
  const send = mutations.create<{ command: MailCommand; attempt: PreparedDelivery }, PreparedDelivery>({
    mutation: async (attempt, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].commands.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: attempt.request,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to queue message"));
      const command = await response.json();
      return { command, attempt };
    },
    onSuccess: ({ command, attempt }) => {
      lastDeliveryAttempt = null;
      localStorage.removeItem(draftSession.draftKey(attempt.draftId));
      const returnHref = props.returnHref;
      const scheduled = Boolean(attempt.scheduledAt);
      toast.success(
        scheduled
          ? `Delivery scheduled for ${dates.formatDateTime(attempt.scheduledAt!, props.dateConfig)}`
          : preferences.undoSeconds > 0
            ? "Message queued. You can undo it directly in the conversation."
            : "Message queued",
      );
      const pendingConversationId = command.result.conversationId;
      navigateTo(
        !scheduled && attempt.request.undoSeconds > 0 && typeof pendingConversationId === "string"
          ? mailConversationHref(props.mailboxId, pendingConversationId, returnHref)
          : returnHref,
      );
    },
    onError: (error) => {
      if (error instanceof ComposeSafetyAttachmentRequested) {
        attachAfterDeliveryReview = true;
        return;
      }
      if (error instanceof ComposeSafetyCancelled) return;
      return prompts.error(error.message);
    },
  });

  const prepareDelivery = async (delivery: { scheduledAt?: string }, abortSignal: AbortSignal): Promise<PreparedDelivery> => {
    validateDelivery();
    const saved = await persist();
    if (!saved) throw new Error(statusMessage());
    const safetyApproval = await reviewSafety(saved, Boolean(delivery.scheduledAt), abortSignal);
    const senderIdentityId = identityId();
    if (!senderIdentityId) throw new Error("Choose a sender identity before sending.");
    return {
      scheduledAt: delivery.scheduledAt,
      contentFingerprint: deliveryFingerprint(delivery),
      draftId: saved.id,
      request: {
        kind: "send",
        draftId: saved.id,
        expectedDraftRevision: saved.revision,
        senderIdentityId,
        scheduledAt: delivery.scheduledAt,
        undoSeconds: delivery.scheduledAt ? 0 : preferences.undoSeconds,
        safetyApproval,
        idempotencyKey: crypto.randomUUID(),
      },
    };
  };

  const finishDeliveryTransition = (reservation: ReturnType<typeof composerTransition.reserve>) => {
    if (!reservation) return;
    composerTransition.release(reservation);
    if (attachAfterDeliveryReview && !disposed) {
      attachAfterDeliveryReview = false;
      attachmentInput?.click();
    }
  };

  const sendDraft = async (delivery: { scheduledAt?: string }) => {
    if (!editable() || uploads().length > 0) return;
    const reservation = composerTransition.reserve("send");
    if (!reservation) return;
    const preparation = new AbortController();
    deliveryPreparationController = preparation;
    try {
      const previousAttempt = lastDeliveryAttempt;
      const reusable =
        Boolean(send.error()) &&
        previousAttempt !== null &&
        previousAttempt.scheduledAt === delivery.scheduledAt &&
        previousAttempt.contentFingerprint === deliveryFingerprint(delivery);
      if (reusable) await send.retry();
      else {
        lastDeliveryAttempt = await prepareDelivery(delivery, preparation.signal);
        await send.mutate(lastDeliveryAttempt);
      }
    } catch (error) {
      if (error instanceof ComposeSafetyAttachmentRequested) attachAfterDeliveryReview = true;
      else if (!(error instanceof ComposeSafetyCancelled)) {
        await prompts.error(error instanceof Error ? error.message : "Message is not ready to send");
      }
    } finally {
      preparation.abort();
      if (deliveryPreparationController === preparation) deliveryPreparationController = null;
      finishDeliveryTransition(reservation);
    }
  };

  const schedule = async () => {
    if (!editable() || uploads().length > 0) return;
    const reservation = composerTransition.reserve("send");
    if (!reservation) return;
    let scheduledAt: string | null = null;
    try {
      scheduledAt = (await chooseScheduledSendTime(props.dateConfig)) ?? null;
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Message is not ready to schedule");
    } finally {
      finishDeliveryTransition(reservation);
    }
    if (!disposed && scheduledAt) await sendDraft({ scheduledAt });
  };

  const openDeliveryOptionsDialog = () =>
    prompts.dialog<boolean>(
      (close) => {
        const [nextPriority, setNextPriority] = createSignal<MailPriority>(priority());
        const [nextDeliveryReceipt, setNextDeliveryReceipt] = createSignal(requestDeliveryReceipt());
        const [nextReadReceipt, setNextReadReceipt] = createSignal(requestReadReceipt());
        const deliveryReceiptSupported = () => selectedIdentity()?.transport.capabilities.dsn === true;
        const save = () => {
          setPriority(nextPriority());
          setRequestDeliveryReceipt(nextDeliveryReceipt());
          setRequestReadReceipt(nextReadReceipt());
          close(true);
        };

        return (
          <div class="flex flex-col gap-3">
            <Select
              label="Priority"
              description="Recipients may see high or low importance when their mail client supports it."
              value={nextPriority}
              onValueChange={(value) => setNextPriority(value === "high" ? "high" : value === "low" ? "low" : "normal")}
              options={[
                { id: "normal", label: "Normal", icon: "ti ti-minus" },
                { id: "high", label: "High", icon: "ti ti-arrow-up" },
                { id: "low", label: "Low", icon: "ti ti-arrow-down" },
              ]}
            />
            <CheckboxCard
              label={deliveryReceiptSupported() ? "Request a delivery receipt" : "Delivery receipts unavailable"}
              description={
                deliveryReceiptSupported()
                  ? "Ask the sending server to report delivery or failure. Receiving servers may not return a report."
                  : "The selected SMTP server does not advertise the DSN capability required to request delivery reports."
              }
              icon="ti ti-mail-check"
              value={nextDeliveryReceipt}
              onValueChange={setNextDeliveryReceipt}
              disabled={!deliveryReceiptSupported()}
            />
            <CheckboxCard
              label="Request a read receipt"
              description="Ask recipients to confirm opening the message. They may decline or their mail client may ignore the request."
              icon="ti ti-eye-check"
              value={nextReadReceipt}
              onValueChange={setNextReadReceipt}
            />
            <NoticeCard tone="neutral" icon={false} bodyClass="flex items-start gap-2">
              <i class="ti ti-info-circle mt-0.5 shrink-0" aria-hidden="true" />
              <p>Receipt requests are optional signals, not proof that a message was delivered or read.</p>
            </NoticeCard>
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button size="sm" type="button" onClick={save}>
                <i class="ti ti-check" aria-hidden="true" />
                Apply
              </Button>
            </div>
          </div>
        );
      },
      { title: "Delivery options", icon: "ti ti-adjustments", size: "medium" },
    );

  const editDeliveryOptions = async () => {
    if (!editable()) return;
    const reservation = composerTransition.reserve("delivery_options");
    if (!reservation) return;
    try {
      await openDeliveryOptionsDialog();
    } finally {
      composerTransition.release(reservation);
    }
  };

  const openMessageOptionsDialog = () =>
    prompts.dialog<"calendar" | "delivery">(
      (close) => (
        <div class="flex flex-col gap-4">
          <Select
            label="Message format"
            description="Choose how this message is written and delivered."
            value={format}
            onValueChange={(value) => setFormat(value === "plain" ? "plain" : "markdown")}
            options={[
              { id: "markdown", label: "Markdown", icon: "ti ti-markdown" },
              { id: "plain", label: "Plain text", icon: "ti ti-align-left" },
            ]}
          />
          <div class="flex flex-col gap-2">
            <Show when={props.calendarIntegrationAvailable}>
              <Button variant="secondary" type="button" class="w-full justify-start" onClick={() => close("calendar")}>
                <i class="ti ti-calendar-plus" aria-hidden="true" />
                Add calendar invitation
              </Button>
            </Show>
            <Button variant="secondary" type="button" class="w-full justify-start" onClick={() => close("delivery")}>
              <i class="ti ti-mail-cog" aria-hidden="true" />
              Delivery options
              <Show when={deliveryOptionsSummary().length > 0}>
                <span class="ml-auto text-xs font-normal text-dimmed">{deliveryOptionsSummary().join(", ")}</span>
              </Show>
            </Button>
          </div>
          <div class="flex justify-end">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              Done
            </Button>
          </div>
        </div>
      ),
      { title: "Message options", icon: "ti ti-adjustments-horizontal", size: "medium" },
    );

  const editMessageOptions = async () => {
    if (!editable()) return;
    const reservation = composerTransition.reserve("delivery_options");
    if (!reservation) return;
    let choice: "calendar" | "delivery" | undefined;
    try {
      choice = await openMessageOptionsDialog();
    } finally {
      composerTransition.release(reservation);
    }
    if (disposed) return;
    if (choice === "calendar") await addCalendarInvitation();
    if (choice === "delivery") await editDeliveryOptions();
  };

  const discard = mutations.create<boolean, void>({
    mutation: async (_input, { abortSignal }) => {
      if (uploads().length > 0) throw new Error("Cancel attachment uploads before discarding this draft.");
      if (!draft()) {
        clearInitialSeed();
        return true;
      }
      const confirmed = await prompts.confirm("This removes the shared draft for everyone with mailbox access.", {
        title: "Discard draft?",
        confirmText: "Discard draft",
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return false;
      stopScheduledSave();
      await serializeDraftMutation(async () => {
        const currentDraft = draft();
        if (!currentDraft) return;
        const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].discard.$post(
          {
            param: { mailboxId: props.mailboxId, draftId: currentDraft.id },
            json: { expectedRevision: currentDraft.revision },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, "Failed to discard draft"));
        localStorage.removeItem(draftSession.draftKey(currentDraft.id));
      });
      return true;
    },
    onSuccess: (discarded) => {
      if (!discarded) return;
      navigateTo(props.returnHref);
    },
    onError: (error) => prompts.error(error.message),
  });
  const discardDraft = async () => {
    if (!editable()) return;
    const reservation = composerTransition.reserve("discard");
    if (!reservation) return;
    try {
      await discard.mutate();
    } finally {
      composerTransition.release(reservation);
    }
  };
  onCleanup(() => {
    deliveryPreparationController?.abort();
    deliveryPreparationController = null;
    send.abort();
    discard.abort();
  });

  const draftHref = (draftId: string, popout = false) => mailDraftHref(props.mailboxId, draftId, props.returnHref, { popout });

  const leaveComposer = async (): Promise<void> => {
    if (uploads().length > 0) {
      await prompts.error("Finish or cancel attachment uploads before closing this draft.");
      return;
    }
    const reservation = composerTransition.reserve("handoff");
    if (!reservation) return;
    stopScheduledSave();
    try {
      if (!draft() && !hasUnsavedChanges()) {
        clearInitialSeed();
        navigateTo(props.returnHref);
        return;
      }
      if (draft() && !lease()) {
        navigateTo(props.returnHref);
        return;
      }
      const currentDraft = await persist();
      if (disposed) return;
      if (!currentDraft) throw new Error(statusMessage());
      try {
        await releaseLease(currentDraft);
      } catch {
        await releaseLeaseOnExit();
      }
      if (!disposed) navigateTo(props.returnHref);
    } catch (error) {
      if (!disposed) await prompts.error(error instanceof Error ? error.message : "Could not close the draft");
    } finally {
      composerTransition.release(reservation);
    }
  };

  const handoffTo = async (href: (draftId: string) => string, popup: Window): Promise<void> => {
    if (uploads().length > 0) {
      popup.close();
      await prompts.error("Finish or cancel attachment uploads before moving this draft.");
      return;
    }
    const reservation = composerTransition.reserve("handoff");
    if (!reservation) return void popup.close();
    stopScheduledSave();
    let releasedDraft: MailDraft | null = null;
    try {
      const currentDraft = await persist();
      if (disposed) return void popup.close();
      if (!currentDraft) throw new Error(statusMessage());
      await releaseLease(currentDraft);
      if (disposed) return void popup.close();
      releasedDraft = currentDraft;
      popup.name = `mail-draft-${currentDraft.id}`;
      popup.location.replace(href(currentDraft.id));
      navigateTo(props.returnHref);
    } catch (error) {
      popup.close();
      if (disposed) return;
      if (releasedDraft && !disposed) {
        try {
          await acquireLease(releasedDraft);
        } catch {
          setStatus("readonly");
          setStatusMessage("Draft editing could not be restored. Reload or take over the draft.");
        }
      }
      await prompts.error(error instanceof Error ? error.message : "Could not open the draft in the requested window");
    } finally {
      composerTransition.release(reservation);
    }
  };

  const openWindow = () => {
    const popup = window.open("about:blank", "", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
    if (!popup) return void prompts.error("Allow pop-up windows to open this draft in a separate window.");
    if (!draft() && !hasUnsavedChanges() && props.initialSeed) {
      popup.location.replace(mailDraftSeedHref(props.mailboxId, props.initialSeed.id, props.returnHref, { popout: true }));
      navigateTo(props.returnHref);
      return;
    }
    void handoffTo((draftId) => draftHref(draftId, true), popup);
  };

  let conflictDialogOpen = false;
  let lastPromptedConflict = leaseConflict();
  const presentLeaseConflict = async () => {
    const currentDraft = draft();
    const conflict = leaseConflict();
    if (!currentDraft || !conflict || conflictDialogOpen) return;
    conflictDialogOpen = true;
    try {
      const choice = await openMailDraftCollaborationDialog({
        conflict,
        currentActor: props.currentActor,
        dateConfig: props.dateConfig,
      });
      if (choice !== "takeover" || disposed) return;
      stopHeartbeat();
      setStatus("preparing");
      const acquired = await acquireLease(currentDraft, true);
      if (!disposed && acquired) {
        setStatus("saved");
        setStatusMessage("");
        toast.success("You can now edit this draft");
      }
    } catch (error) {
      if (!disposed) {
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : "Draft editing could not be taken over");
      }
    } finally {
      conflictDialogOpen = false;
    }
  };

  createEffect(() => {
    const conflict = leaseConflict();
    if (!conflict || conflict === lastPromptedConflict || conflictDialogOpen) return;
    lastPromptedConflict = conflict;
    queueMicrotask(() => void presentLeaseConflict());
  });

  const collaborationStatus = () => {
    const conflict = leaseConflict();
    return conflict ? mailDraftCollaborationCopy(conflict, props.currentActor).status : statusMessage();
  };
  const connectionUnavailable = () => status() === "readonly" && Boolean(lease()) && !leaseConflict();
  const readonlyActionLabel = () => {
    const conflict = leaseConflict();
    return conflict ? mailDraftCollaborationCopy(conflict, props.currentActor).takeoverLabel : "Retry";
  };
  const handleReadonlyAction = () => (leaseConflict() ? void presentLeaseConflict() : void resumeCurrentLease());

  const composerIntent = () => draft()?.intent ?? initial.intent;
  const retryPreview = () => void previewQuery.refresh();
  const IdentitySwitcher = () => {
    const label = () => selectedIdentity()?.label ?? "Choose sender";
    const address = () => selectedIdentity()?.fromAddress ?? "";
    const Content = () => (
      <>
        <span class="shrink-0 text-dimmed">from</span>
        <span class="min-w-0 truncate font-medium text-secondary" title={address()}>
          {label()}
        </span>
      </>
    );

    return (
      <Show
        when={verifiedIdentities().length > 1}
        fallback={
          <span class="flex min-w-0 items-center gap-1.5">
            <Content />
          </span>
        }
      >
        <Dropdown.Root position="bottom-right" width="18rem" items={identityMenuItems()}>
          <Dropdown.Trigger
            appearance="plain"
            type="button"
            class="focus-ui flex max-w-[min(18rem,45vw)] min-w-0 items-center gap-1.5 rounded-[var(--ui-radius-control)] px-1.5 py-1 text-sm hover:bg-[var(--ui-hover)] disabled:cursor-default"
            aria-label={`Change sender identity. Current sender: ${label()}${address() ? `, ${address()}` : ""}`}
            disabled={!editable()}
          >
            <Content />
            <i class="ti ti-chevron-down shrink-0 text-xs text-dimmed" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    );
  };

  const slashCompletion = createMemo<Completion[]>(() => [
    {
      trigger: "/",
      dropdown: true,
      debounceMs: 180,
      suggest: async (query, context, signal) => {
        const response = await apiClient.mailboxes[":mailboxId"]["compose-suggestions"].$post(
          {
            param: { mailboxId: props.mailboxId },
            json: {
              query,
              draft: content(),
              conversationId: conversationId(),
            },
          },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, "Compose templates could not be loaded"));
        const suggestions = await response.json();
        return suggestions.map((suggestion) => ({
          text: `/${suggestion.shortcut}`,
          label: suggestion.name,
          hint: suggestion.kind,
          textEdit: {
            start: context.tokenStart,
            end: context.caret,
            text: suggestion.markdown,
          },
        }));
      },
    },
  ]);

  return (
    <div class="mail-composer-surface relative h-full min-w-0 overflow-hidden" {...attachmentDropzone.handlers}>
      <Show when={editable() && attachmentDropzone.isDragging()}>
        <div
          class="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-[var(--ui-radius-surface)] border-2 border-dashed border-[var(--ui-accent)] bg-[color-mix(in_srgb,var(--ui-surface)_88%,transparent)]"
          role="status"
        >
          <div class="flex items-center gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-4 py-3 text-sm font-medium text-primary shadow-lg">
            <i class="ti ti-paperclip text-[var(--ui-accent)]" aria-hidden="true" />
            Drop files to attach
          </div>
        </div>
      </Show>
      <Show when={!props.popout}>
        <header class="flex shrink-0 items-center gap-2 bg-[var(--ui-surface-subtle)] px-3 py-2">
          <Tooltip.Anchor content="Back to mailbox">
            <IconButton
              type="button"
              label="Back to mailbox"
              disabled={composerTransition.active() !== null}
              onClick={() => void leaveComposer()}
            >
              <i class="ti ti-arrow-left" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
          <span class="shrink-0 text-sm font-semibold text-primary">{intentLabel(composerIntent())}</span>
          <IdentitySwitcher />
          <span class="min-w-0 flex-1" />
          <Show when={status() === "error" || status() === "readonly"}>
            <span
              class="min-w-0 truncate text-xs"
              classList={{
                "text-red-600 dark:text-red-300": status() === "error" || connectionUnavailable(),
                "text-dimmed": status() === "readonly" && !connectionUnavailable(),
              }}
              role="status"
            >
              {collaborationStatus()}
            </span>
          </Show>
          <Show when={status() === "readonly" && draft() && (lease() || leaseConflict())}>
            <Button variant="secondary" size="sm" type="button" onClick={handleReadonlyAction}>
              {readonlyActionLabel()}
            </Button>
          </Show>
          <Show when={editable() && (draft()?.recoveryCopyCount ?? 0) > 0}>
            <Button variant="secondary" size="sm" type="button" onClick={() => void restoreRecoveryCopy()}>
              <i class="ti ti-history" aria-hidden="true" /> Recover changes
            </Button>
          </Show>
          <Tooltip.Anchor content="Open in new window">
            <IconButton type="button" label="Open in new window" disabled={!editable()} onClick={openWindow}>
              <i class="ti ti-app-window" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
        </header>
      </Show>

      <Show when={props.popout && (status() === "error" || status() === "readonly")}>
        <div
          class="flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
          classList={{
            "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300": status() === "error" || connectionUnavailable(),
            "border-b border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-secondary":
              status() === "readonly" && !connectionUnavailable(),
          }}
          role="status"
        >
          <span class="min-w-0 flex-1 truncate">{collaborationStatus()}</span>
          <Show when={status() === "readonly" && draft() && (lease() || leaseConflict())}>
            <Button variant="secondary" size="sm" type="button" onClick={handleReadonlyAction}>
              {readonlyActionLabel()}
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={props.popout && editable() && (draft()?.recoveryCopyCount ?? 0) > 0}>
        <div class="flex shrink-0 items-center gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <span class="min-w-0 flex-1">Saved conflict changes are available for this draft.</span>
          <Button variant="secondary" size="sm" type="button" onClick={() => void restoreRecoveryCopy()}>
            <i class="ti ti-history" aria-hidden="true" /> Recover
          </Button>
        </div>
      </Show>

      <Show when={props.popout}>
        <div class="flex shrink-0 items-center bg-[var(--ui-surface-subtle)] px-3 py-1.5">
          <IdentitySwitcher />
        </div>
      </Show>

      <Show when={lifecycleTransition()}>
        {(transition) => (
          <MailComposerLifecycleNotice
            transition={transition()}
            savingCopy={saveLifecycleCopy.loading()}
            onCopyText={() => void copyLifecycleText()}
            onSaveAsNew={() => void saveLifecycleCopy.mutate()}
            onOpenMessage={openLifecycleMessage}
          />
        )}
      </Show>

      <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3">
        <div class="grid shrink-0 gap-1.5 py-1.5 text-sm lg:grid-cols-2">
          <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 lg:col-span-2">
            <span class="text-dimmed">To</span>
            <div class="flex min-w-0 items-center gap-2">
              <div class="min-w-0 flex-1">
                <MailRecipientInput placeholder="Recipients" value={to} onChange={setTo} disabled={!editable()} />
              </div>
              <Show when={!showCc()}>
                <Button variant="ghost" size="sm" type="button" disabled={!editable()} onClick={() => setShowCc(true)}>
                  Cc/Bcc
                </Button>
              </Show>
            </div>
          </div>
          <Show when={showCc()}>
            <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2">
              <span class="text-dimmed">Cc</span>
              <MailRecipientInput placeholder="Cc recipients" value={cc} onChange={setCc} disabled={!editable()} />
            </div>
            <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2">
              <span class="text-dimmed">Bcc</span>
              <MailRecipientInput placeholder="Bcc recipients" value={bcc} onChange={setBcc} disabled={!editable()} />
            </div>
          </Show>
          <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 lg:col-span-2">
            <span class="text-dimmed">Subject</span>
            <TextInput aria-label="Subject" value={subject} onValueChange={setSubject} maxLength={998} disabled={!editable()} />
          </div>
        </div>

        <MailComposerEditor
          format={format}
          body={body}
          onBodyInput={setBody}
          editable={editable}
          completions={slashCompletion}
          panes={currentComposerPanes}
          onPanesChange={updateComposerPanes}
          preview={preview}
          previewError={() => previewQuery.error()?.message}
          onRetryPreview={retryPreview}
          onEditorReady={focusFreshEditorAtStart}
          history={
            conversationId()
              ? () => (
                  <MailComposerHistory
                    mailboxId={props.mailboxId}
                    conversationId={conversationId()!}
                    identities={props.identities}
                    dateConfig={props.dateConfig}
                    active={() => isPanesItemVisible(currentComposerPanes(), "history")}
                  />
                )
              : undefined
          }
        />

        <MailComposerAttachments
          attachments={() => draft()?.attachments ?? props.initialSeed?.attachments ?? []}
          uploads={uploads}
          editable={editable}
          canShare={Boolean(props.canShareAttachments)}
          shareLoading={attachments.shareLoading}
          onInsertLink={(attachmentId) => void attachments.insertAttachmentLink(attachmentId)}
          onRemove={(attachmentId) => void attachments.removeAttachment(attachmentId)}
          onRetryUpload={(upload) => void attachments.retryUpload(upload)}
          onCancelUpload={(upload) => void attachments.cancelUpload(upload).catch((error) => prompts.error(error.message))}
        />
      </div>

      <footer class="flex shrink-0 items-center gap-2 bg-[var(--ui-surface-subtle)] px-3 py-2">
        <SplitButton
          class="mail-compose-action"
          size="sm"
          type="button"
          loading={send.loading()}
          disabled={!editable() || uploads().length > 0}
          menuLabel="More send options"
          items={[
            { label: "Save as draft", icon: "ti ti-device-floppy", action: () => void leaveComposer() },
            { label: "Send later", icon: "ti ti-clock", action: () => void schedule() },
          ]}
          onClick={() => void sendDraft({})}
        >
          <i class={`ti ${intentIcon(composerIntent())}`} aria-hidden="true" />
          {intentLabel(composerIntent())}
        </SplitButton>
        <Button
          size="sm"
          variant="ai"
          type="button"
          loading={composeWithAi.loading()}
          disabled={!editable() || uploads().length > 0 || composeWithAi.loading()}
          onClick={() =>
            void composeWithAi
              .mutate()
              .catch((error: unknown) => prompts.error(error instanceof Error ? error.message : "Assistant chat could not be created"))
          }
        >
          <i class="ti ti-sparkles" aria-hidden="true" /> Write with AI
        </Button>
        <Tooltip.Anchor
          content={deliveryOptionsSummary().length > 0 ? `Message options: ${deliveryOptionsSummary().join(", ")}` : "Message options"}
        >
          <Button
            size="sm"
            variant="secondary"
            type="button"
            class="relative"
            aria-label="Message options"
            disabled={!editable()}
            onClick={() => void editMessageOptions()}
          >
            <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
            <span class="hidden sm:inline">Options</span>
            <Show when={deliveryOptionsSummary().length > 0}>
              <span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ui-accent)]" aria-hidden="true" />
            </Show>
          </Button>
        </Tooltip.Anchor>
        <Tooltip.Anchor content="Attach files">
          <IconButton
            size="sm"
            variant="secondary"
            type="button"
            label="Attach files"
            disabled={!editable()}
            onClick={() => attachmentInput?.click()}
          >
            <i class="ti ti-paperclip" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
        <input
          ref={attachmentInput}
          type="file"
          class="hidden"
          multiple
          disabled={!editable()}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void attachments.addFiles(files);
          }}
        />
        <span class="flex-1" />
        <Tooltip.Anchor content="Discard draft">
          <IconButton type="button" label="Discard draft" disabled={!editable() || discard.loading()} onClick={() => void discardDraft()}>
            <i class={`ti ${discard.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
      </footer>
    </div>
  );
}
