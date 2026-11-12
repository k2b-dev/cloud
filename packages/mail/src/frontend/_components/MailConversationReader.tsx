import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { CloudTheme } from "@k2b/cloud/shared";
import { documentNavigate, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  announce,
  Button,
  CheckboxCard,
  ContextMenu,
  type DropdownAction,
  type DropdownItem,
  Lightbox,
  NoticeCard,
  Placeholder,
  prefersReducedMotion,
  prompts,
  ScrollArea,
  Select,
  toast,
  useLocale,
} from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import { mailCommandMessages } from "../../command-messages";
import type {
  AutomationLogItem,
  ConversationDraftSummary,
  ConversationWorkStatus,
  DeriveDraftFromMessageInput,
  DraftDerivationKind,
  DraftIntent,
  MailDraftSeed,
  SenderIdentity,
} from "../../contracts";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "../../service/collaboration";
import type { ConversationKeep } from "../../service/conversation-keeps";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import type { LocalTag } from "../../service/local-tags";
import type { ConversationPresenceParticipant } from "../../service/presence";
import type { ConversationReminder } from "../../service/reminders";
import type { MailDetailErrors, MailWorkspaceMessage } from "../../service/workspace";
import { automationLogHref } from "../automation-log-href";
import { readApiError } from "./api-response";
import { openMailActivityDialog } from "./MailActivityDialog";
import MailAutomationTrace from "./MailAutomationTrace";
import MailConversationNote from "./MailConversationNote";
import MailConversationSummaryCard, { type MailSummaryGenerateMode, showsConversationSummary } from "./MailConversationSummaryCard";
import { attachmentLightboxItem } from "./MailMessageAttachments";
import MailMessageCard from "./MailMessageCard";
import MailReaderHead, { type MailReaderHint } from "./MailReaderHead";
import MailReplyBox, { type MailReplyBoxApi } from "./MailReplyBox";
import type { MailActionId } from "./mail-actions";
import { useMailCloudId } from "./mail-cloud-id";
import { deriveReplyRecipients, quoteReplyBody } from "./mail-compose-derivation";
import { mailDraftSeedHref } from "./mail-compose-route";
import { initialConversationMessageId, isNearConversationEnd } from "./mail-conversation-history";
import { createMailConversationLinks } from "./mail-conversation-links";
import { type MailRespondIntent, type MailRespondRequest, mailConversationMenuItems } from "./mail-conversation-menu";
import { createMailConversationNotes } from "./mail-conversation-notes";
import { createMailConversationState } from "./mail-conversation-state";
import { buildMailConversationTimeline } from "./mail-conversation-timeline";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { describeUnavailableMailDetails } from "./mail-detail-availability";
import { createRetryToasts } from "./mail-feedback";
import { messageDeliveryAllowsResponses } from "./mail-message-presentation";
import { buildMailListHref, mailRouteUrl } from "./mail-navigation";
import { mailReaderMessages } from "./mail-reader-messages";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "./mail-sender-identity-status";
import { mailSummaryMessages } from "./mail-summary-messages";
import type { MailReadingFormat } from "./mail-user-preferences";
import { captureMailWorkspaceRefreshError } from "./mail-workspace-refresh";

/** From this many messages on, the reader shows the newest few and folds the rest behind one button. */
const MAIL_READER_COLLAPSE_FROM = 5;
const MAIL_READER_NEWEST_SHOWN = 3;

export default function MailConversationReader(props: {
  currentUserId?: string;
  mailboxId: string;
  requestUrl: string;
  canWrite: boolean;
  canAdmin: boolean;
  /** False for a person who sees only the conversations assigned to them: no merging or splitting. */
  mailboxWide: boolean;
  identities: SenderIdentity[];
  /** Opens the mailbox's sender settings for a person who can administer it. */
  onOpenDeliverySettings: () => void;
  selectionKey: string | null;
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  unread: boolean;
  flagged: boolean;
  inJunk: boolean;
  /** The conversation is kept: Cloud refuses to delete it or move it to Trash, Junk, or Drafts. */
  keep: ConversationKeep | null;
  reference: string | null;
  subject: string;
  messages: MailWorkspaceMessage[];
  activity: MailActivityEvent[];
  conversationSummary: ConversationContentSummary | null;
  conversationDrafts: ConversationDraftSummary[];
  totalMessageCount: number;
  error: string | null;
  dateConfig: DateContext;
  readingFormat: MailReadingFormat;
  /** `null` while the browser has not yet resolved Automatic for this island. */
  theme: CloudTheme | null;
  calendarIntegrationAvailable: boolean;
  /** The open conversation's assignees, status and "Show later"; null while it has none, such as a single message. */
  collaboration: ConversationCollaboration | null;
  /** Your own reminder for the conversation. */
  reminder: ConversationReminder | null;
  assignableUsers: MailAssignableUser[];
  onCollaborationChange: (state: ConversationCollaboration) => void;
  /** The conversation's tags. */
  tags: readonly LocalTag[];
  /** The newest internal notes, and the cursor of earlier ones. */
  comments: readonly ConversationComment[];
  commentsCursor: string | null;
  /** The parts of the conversation that could not load, such as its notes or activity; null for each that loaded. */
  detailErrors: MailDetailErrors;
  /** Who else has the conversation open. */
  presence: readonly ConversationPresenceParticipant[];
  /** Whether the person has seen a one-time hint in this mailbox. */
  hintSeen: (hint: MailReaderHint) => boolean;
  /** The person had arranged their own toolbar before Mail v5 replaced it with fixed actions. */
  toolbarCustomized: boolean;
  onHintSeen: (hint: MailReaderHint) => void;
  actionPending: boolean;
  structurePending: boolean;
  onAction: (actionId: MailActionId, options?: { silent?: boolean }) => void | Promise<void>;
  onOpenHref: (href: string, replace?: boolean) => void | Promise<void>;
  onManageTags: () => void | Promise<void>;
  onMergeConversation: () => void | Promise<void>;
  onReassignMessage: (messageId: string) => void | Promise<void>;
  /** What rules did with this conversation, newest first. */
  automationTrace: AutomationLogItem[];
  onUndoAutomation: (item: AutomationLogItem) => void | Promise<void>;
  onAssignConversation: () => void | Promise<void>;
  onAssignConversationToMe: () => void | Promise<void>;
  automationPending?: boolean;
  /** Whether you are responsible, and who else is; null where nobody can be assigned. */
  assignment: { assigned: boolean; others: string[] } | null;
  /** Null for a conversation without a status, such as a single message. */
  workStatus: ConversationWorkStatus | null;
  completionPending: boolean;
  onSetCompletion: (completion: "done" | "open") => void;
  /** An answer a list row asked for; the reader starts it once that conversation is open here. */
  respondRequest: MailRespondRequest | null;
  onRespondRequestHandled: () => void;
  onSplitMessage: (messageId: string) => void | Promise<void>;
  onKeep: () => void | Promise<void>;
  onStopKeeping: () => void | Promise<void>;
  onSummarySaved: (conversationId: string, summary: ConversationContentSummary) => Promise<void>;
  onReconcile: () => Promise<void>;
  onReconcileAfterWrite: () => Promise<void>;
  onClose: (event: LinkNavigateEvent) => void | Promise<void>;
  currentUserEmail?: string | null;
  /** Live dictation is set up and allowed for this person. */
  liveDictation?: boolean;
  /** This browser's last choice for a draft: full screen moves the list and details aside (F7). */
  draftFullscreen?: boolean;
  onToggleDraftFullscreen?: () => void;
  /** The draft open in this conversation, or null; the workspace keeps it in the URL. */
  onDraftChange?: (draftId: string | null, options?: { history?: boolean }) => void;
}) {
  const locale = useLocale();
  let seedStorage: Storage | undefined;
  onMount(() => {
    if (props.currentUserId) {
      try {
        seedStorage = openMailUserDraftStorage(localStorage, props.currentUserId);
      } catch {
        /* Starting a draft reports storage failure. */
      }
    }
  });
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const retryToasts = createMemo(
    on(
      () => props.mailboxId,
      () => createRetryToasts(),
    ),
  );
  const summaryText = createMemo(() => mailSummaryMessages.resolve([locale()]).t);
  const selectedHistoryMessageId = () =>
    props.selectedMessageId && props.messages.some((message) => message.id === props.selectedMessageId)
      ? props.selectedMessageId
      : initialConversationMessageId(props.messages);
  const initialMessageId = selectedHistoryMessageId();
  const readerText = createMemo(() => mailReaderMessages.resolve([locale()]).t);
  const notes = createMailConversationNotes({
    mailboxId: () => props.mailboxId,
    conversationId: () => props.selectedConversationId,
    comments: () => props.comments,
    cursor: () => props.commentsCursor,
  });
  // The conversation in reading order: oldest first, the newest message at the bottom, notes at their time.
  const timeline = createMemo(() => buildMailConversationTimeline(props.messages, notes.notes()));
  // Live updates rebuild every timeline item. Rows are keyed by their stable id
  // so an update re-renders values in place instead of remounting each message
  // body, which would reload its frame and close opened quoted text.
  const timelineIds = createMemo(() => timeline().map((item) => item.id));
  const timelineItems = createMemo(() => new Map(timeline().map((item) => [item.id, item])));
  const latestMessage = createMemo(() => props.messages.at(-1) ?? null);
  const [expandedMessages, setExpandedMessages] = createSignal(new Set(initialMessageId ? [initialMessageId] : []));
  // A long conversation shows its newest messages; the older ones wait behind one "n older messages" row above them.
  // An expanded older message, such as the one a link selected, shows the whole conversation, and it stays shown
  // for that conversation when the message is collapsed again, so the header just used never unmounts.
  const [showOlder, setShowOlder] = createSignal(false);
  // Printing shows every message only for the print; it never pins the fold open.
  const [printing, setPrinting] = createSignal(false);
  let historyScroller: HTMLDivElement | undefined;
  let olderPinnedFor: string | null = null;
  // New messages never fold away a card that is already shown, such as one with focus or an open dialog:
  // the fold stays above the oldest message shown so far in each conversation, also after switching back to it.
  const foldBoundaries = new Map<string | null, string>();
  const rememberFold = (selection: string | null, messageId: string) => {
    foldBoundaries.delete(selection);
    foldBoundaries.set(selection, messageId);
    // As many conversations as the reader remembers positions for.
    if (foldBoundaries.size > 50) foldBoundaries.delete(foldBoundaries.keys().next().value!);
  };
  /** Where the shown part of the timeline starts, and how many messages wait above it. */
  const olderMessages = createMemo(() => {
    const selection = props.selectionKey;
    if (showOlder() || printing() || (selection !== null && olderPinnedFor === selection)) return null;
    const items = timeline();
    const messageIndexes = items.flatMap((item, index) => (item.kind === "message" ? [index] : []));
    if (messageIndexes.length < MAIL_READER_COLLAPSE_FROM) {
      // Every message shows; a later arrival that crosses the threshold folds none of them away.
      const first = items.find((item) => item.kind === "message");
      if (first?.kind === "message") rememberFold(selection, first.message.id);
      return null;
    }
    let start = messageIndexes[messageIndexes.length - MAIL_READER_NEWEST_SHOWN]!;
    const boundary = foldBoundaries.get(selection) ?? null;
    const boundaryIndex = boundary ? items.findIndex((item) => item.kind === "message" && item.message.id === boundary) : -1;
    if (boundaryIndex >= 0 && boundaryIndex < start) start = boundaryIndex;
    const firstShown = items.slice(start).find((item) => item.kind === "message");
    if (firstShown?.kind === "message") rememberFold(selection, firstShown.message.id);
    const expanded = expandedMessages();
    if (items.slice(0, start).some((item) => item.kind === "message" && expanded.has(item.message.id))) {
      olderPinnedFor = selection;
      return null;
    }
    const count = items.slice(0, start).filter((item) => item.kind === "message").length;
    return count > 0 ? { start, count } : null;
  });
  const visibleTimelineIds = createMemo(() => {
    const older = olderMessages();
    return older ? timelineIds().slice(older.start) : timelineIds();
  });
  const revealOlderMessages = (start: number) => {
    // A note may sit at the fold; focus goes to the newest message the row showed.
    const lastHidden = timeline()
      .slice(0, start)
      .findLast((item) => item.kind === "message");
    setShowOlder(true);
    // Earlier notes belong to the older messages that are now shown.
    if (notes.hasEarlier()) void notes.loadEarlier();
    // The row leaves; focus goes to the last message it showed, right above where the person was reading.
    if (lastHidden?.kind === "message")
      queueMicrotask(() =>
        historyScroller
          ?.querySelector<HTMLElement>(`[data-mail-message-id="${CSS.escape(lastHidden.message.id)}"] [data-mail-message-header]`)
          ?.focus(),
      );
  };
  // All attachments of the conversation in reading order, so the Lightbox's arrows step through every one of them.
  const conversationAttachments = createMemo(() =>
    props.messages.flatMap((message) => message.attachments.map((attachment) => ({ messageId: message.id, attachment }))),
  );
  const [shownAttachment, setShownAttachment] = createSignal<number | null>(null);
  const lightboxItems = createMemo(() =>
    conversationAttachments().map(({ messageId, attachment }) =>
      attachmentLightboxItem(
        attachment,
        `/api/mail/mailboxes/${props.mailboxId}/messages/${messageId}/attachments/${attachment.id}`,
        locale(),
      ),
    ),
  );
  const openAttachment = (messageId: string, attachmentId: string) => {
    const index = conversationAttachments().findIndex((entry) => entry.messageId === messageId && entry.attachment.id === attachmentId);
    if (index >= 0) setShownAttachment(index);
  };
  const [messageSelections, setMessageSelections] = createSignal<Record<string, string>>({});
  const [pendingNewMessages, setPendingNewMessages] = createSignal(0);
  type SummaryEdit = { mailboxId: string; conversationId: string; expectedSummaryRevision: number; summary: string };
  const summarySave = createMemo(
    on(
      () => props.mailboxId,
      () => {
        let active = true;
        const current = mutations.create<{ refreshError: Error | null; refresh: () => Promise<void> }, SummaryEdit, { edit: SummaryEdit }>({
          onBefore: (edit) => ({ edit }),
          mutation: async ({ mailboxId, conversationId, expectedSummaryRevision, summary }, { abortSignal }) => {
            if (!active) throw new DOMException("Mailbox changed", "AbortError");
            const onSummarySaved = props.onSummarySaved;
            const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].summary.$put(
              {
                param: { mailboxId, conversationId },
                json: { expectedSummaryRevision, summary },
              },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(await readApiError(response, t().updateSummaryFailed));
            const updated = await response.json();
            abortSignal.throwIfAborted();
            const refresh = () => onSummarySaved(conversationId, updated);
            return { refreshError: await captureMailWorkspaceRefreshError(refresh), refresh };
          },
          // The summary card shows the saved text; focus is back on the button that opened the form, which does not say so.
          onSuccess: ({ refreshError, refresh }) => {
            if (refreshError) reportSummaryRefreshFailure(refreshError, refresh);
            else announce(t().summarySaved);
          },
          // The form has closed, so Retry sends the captured text again instead of losing it.
          onError: (error, context) =>
            retryToasts()(error.message, { retryLabel: t().retry, retry: () => context && current.mutate(context.edit) }),
        });
        onCleanup(() => {
          active = false;
          current.abort();
        });
        return current;
      },
    ),
  );
  /** The summary was saved, only the view is stale, so Retry repeats the refresh, not the save. */
  const reportSummaryRefreshFailure = (error: Error, refresh: () => Promise<void>): void => {
    const generation = readerMailboxGeneration;
    retryToasts()(error.message, {
      title: t().summaryRefreshFailed,
      retryLabel: t().retry,
      retry: async () => {
        const next = await captureMailWorkspaceRefreshError(refresh);
        if (next && !disposed && generation === readerMailboxGeneration) reportSummaryRefreshFailure(next, refresh);
      },
    });
  };
  const summarySaving = () => summarySave().loading();
  const automationOrderHref = () => `/app/mail/${props.mailboxId}/automations/workflows`;
  /** The Protokoll entry with the whole chain, from rule to the fixed row that decided. */
  const automationWhyHref = (item: AutomationLogItem) => automationLogHref(props.mailboxId, item.id);
  type SummaryGenerate = { mailboxId: string; conversationId: string; expectedSummaryRevision: number; mode: MailSummaryGenerateMode };
  /** A person asks the AI for this conversation's summary; the card shows "being written" until the live update arrives. */
  const summaryGenerate = createMemo(
    on(
      () => props.mailboxId,
      () => {
        let active = true;
        const current = mutations.create<void, SummaryGenerate, { request: SummaryGenerate }>({
          onBefore: (request) => ({ request }),
          mutation: async ({ mailboxId, conversationId, expectedSummaryRevision, mode }, { abortSignal }) => {
            if (!active) throw new DOMException("Mailbox changed", "AbortError");
            const onSummarySaved = props.onSummarySaved;
            const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].summary.generate.$post(
              { param: { mailboxId, conversationId }, json: { expectedSummaryRevision, mode } },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(await readApiError(response, summaryText().generateFailed));
            const state = await response.json();
            abortSignal.throwIfAborted();
            const refresh = () => onSummarySaved(conversationId, state);
            const refreshError = await captureMailWorkspaceRefreshError(refresh);
            if (refreshError && active) reportSummaryRefreshFailure(refreshError, refresh);
          },
          onError: (error, context) =>
            retryToasts()(error.message, { retryLabel: t().retry, retry: () => context && current.mutate(context.request) }),
        });
        onCleanup(() => {
          active = false;
          current.abort();
        });
        return current;
      },
    ),
  );
  const generateSummary = (mode: MailSummaryGenerateMode) => {
    const conversationId = props.selectedConversationId;
    const current = props.conversationSummary;
    if (!conversationId || !current || summaryGenerate().loading()) return;
    void summaryGenerate().mutate({ mailboxId: props.mailboxId, conversationId, expectedSummaryRevision: current.summaryRevision, mode });
  };
  const closeHref = () => buildMailListHref(mailRouteUrl(props.requestUrl));
  let cleanupPrint: (() => void) | null = null;
  let readerScrollFrame: number | null = null;
  let followingNewest = true;
  let disposed = false;
  let readerMailboxGeneration = 0;
  const scrollPositions = new Map<string, number>();
  const expandedBySelection = new Map<string, Set<string>>();
  // Conversations whose older messages the person revealed; going back keeps them shown with the scroll position.
  const olderShownBySelection = new Set<string>();

  const rememberReaderState = (selectionKey: string, scrollTop: number, expanded: Set<string>) => {
    scrollPositions.delete(selectionKey);
    scrollPositions.set(selectionKey, scrollTop);
    expandedBySelection.delete(selectionKey);
    expandedBySelection.set(selectionKey, new Set(expanded));
    if (showOlder() || olderPinnedFor === selectionKey) olderShownBySelection.add(selectionKey);
    else olderShownBySelection.delete(selectionKey);
    if (scrollPositions.size <= 50) return;
    const oldest = scrollPositions.keys().next().value;
    if (!oldest) return;
    scrollPositions.delete(oldest);
    expandedBySelection.delete(oldest);
    olderShownBySelection.delete(oldest);
  };

  const scheduleReaderScroll = (options: {
    selectionKey: string | null;
    messageId?: string | null;
    scrollTop?: number;
    behavior?: ScrollBehavior;
  }) => {
    if (readerScrollFrame !== null) cancelAnimationFrame(readerScrollFrame);
    readerScrollFrame = requestAnimationFrame(() => {
      readerScrollFrame = null;
      if (disposed || props.selectionKey !== options.selectionKey || !historyScroller) return;
      if (options.scrollTop !== undefined) {
        historyScroller.scrollTop = options.scrollTop;
      } else if (options.messageId) {
        // The message's start shows at the top, also for the newest one at the bottom of the conversation.
        const message = historyScroller.querySelector<HTMLElement>(`[data-mail-message-id="${CSS.escape(options.messageId)}"]`);
        if (message) {
          const scrollerBounds = historyScroller.getBoundingClientRect();
          const messageBounds = message.getBoundingClientRect();
          historyScroller.scrollTo({
            top: Math.max(0, historyScroller.scrollTop + messageBounds.top - scrollerBounds.top - 8),
            behavior: options.behavior ?? "auto",
          });
        }
      }
      followingNewest = readingNewest();
    });
  };

  /** The person reads at the end of the conversation, where the newest message is: new messages then show at once. */
  const readingNewest = (): boolean => !historyScroller || isNearConversationEnd(historyScroller);

  const handleReaderScroll = () => {
    if (!historyScroller) return;
    followingNewest = readingNewest();
    if (followingNewest && pendingNewMessages() > 0) setPendingNewMessages(0);
  };

  const jumpToNewest = () => {
    const newest = props.messages.at(-1);
    if (!newest) return;
    setExpandedMessages((current) => new Set(current).add(newest.id));
    setPendingNewMessages(0);
    followingNewest = true;
    scheduleReaderScroll({ selectionKey: props.selectionKey, messageId: newest.id, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const editConversationSummary = async () => {
    const generation = readerMailboxGeneration;
    const conversationId = props.selectedConversationId;
    const current = props.conversationSummary;
    if (!conversationId || !current || summarySaving()) return;
    const values = await prompts.form({
      title: current.summary ? t().editSummary : t().createSummary,
      icon: "ti ti-notes",
      size: "large",
      fields: {
        summary: {
          type: "text",
          label: t().summary,
          description: t().summaryDescription,
          default: current.summary ?? "",
          multiline: true,
          lines: 8,
          maxLength: 50_000,
          markdown: true,
        },
      },
      confirmText: current.summary ? t().saveSummary : t().createSummary,
    });
    if (!values || disposed || generation !== readerMailboxGeneration || conversationId !== props.selectedConversationId) return;
    await summarySave().mutate({
      mailboxId: props.mailboxId,
      conversationId,
      expectedSummaryRevision: current.summaryRevision,
      summary: String(values.summary ?? ""),
    });
  };

  const toggleMessage = (messageId: string) =>
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });

  /** Opens a new message from a local seed on its compose page. */
  const openDraftSeed = async (seed: MailDraftSeed, stillCurrent: () => boolean) => {
    const store = await importOnDemand(() => import("./mail-draft-seed-store"));
    if (!store || disposed || !stillCurrent()) return;
    try {
      if (!seedStorage) throw new Error(t().localDraftFailed);
      store.storeMailDraftSeed(seedStorage, seed);
    } catch {
      void prompts.error(t().localDraftFailed, {
        title: t().startMessageFailed,
      });
      return;
    }
    documentNavigate(mailDraftSeedHref(props.mailboxId, seed.id, props.requestUrl, { popout: false }));
  };

  /** Names why no verified sender can send, and lets a mailbox admin open the setting that fixes it. */
  const explainSenderUnavailable = async () => {
    const generation = readerMailboxGeneration;
    const status = mailSenderIdentityStatusMessages.resolve([locale()]).t;
    const detail = senderUnavailableDetail(props.identities, locale());
    if (!props.canAdmin) return void (await prompts.error(`${detail} ${status.askAdmin}`, { title: status.cannotSend }));
    const open = await prompts.confirm(detail, { title: status.cannotSend, confirmText: status.openSenderSettings });
    if (open && !disposed && generation === readerMailboxGeneration) props.onOpenDeliverySettings();
  };

  const derivedDraft = createMemo(
    on(
      () => props.mailboxId,
      () => {
        let active = true;
        const current = mutations.create<
          MailDraftSeed,
          {
            message: MailWorkspaceMessage;
            input: Omit<DeriveDraftFromMessageInput, "idempotencyKey">;
          },
          { message: MailWorkspaceMessage }
        >({
          onBefore: ({ message }) => ({ message }),
          mutation: async ({ message, input }, { abortSignal }) => {
            if (!active) throw new DOMException("Mailbox changed", "AbortError");
            const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
              {
                param: { mailboxId: props.mailboxId },
                json: {
                  origin: {
                    kind: "derive",
                    messageId: message.id,
                    input: {
                      kind: input.kind,
                      senderIdentityId: input.senderIdentityId,
                      includeAttachments: input.includeAttachments,
                    },
                  },
                },
              },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(await readApiError(response, t().createFromMessageFailed));
            return response.json();
          },
          onSuccess: (seed, context) => {
            const generation = readerMailboxGeneration;
            if (context && props.messages.some((message) => message.id === context.message.id)) {
              void openDraftSeed(
                seed,
                () => generation === readerMailboxGeneration && props.messages.some((message) => message.id === context.message.id),
              );
            }
          },
          onError: (error) => prompts.error(error.message),
        });
        onCleanup(() => {
          active = false;
          current.abort();
        });
        return current;
      },
    ),
  );
  // The reply box under the conversation (Mail v5): Reply, Reply all, Forward, a quote, a returned draft, and the
  // internal note all land in it. It replaces the reply pill, the "Continue draft?" dialog, and the draft rows.
  let replyBox: MailReplyBoxApi | null = null;
  const scrollToReplyBox = () =>
    queueMicrotask(() =>
      historyScroller
        ?.querySelector("[data-mail-reply-box-frame]")
        ?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" }),
    );
  const composerBusy = () => derivedDraft().loading();

  const startComposer = (intent: DraftIntent, message: MailWorkspaceMessage, quotedBody?: string) => {
    if (!props.selectedConversationId || intent === "new" || !replyBox) return;
    replyBox.open(intent, { message, quote: quotedBody });
    scrollToReplyBox();
  };

  const deriveMessage = async (kind: DraftDerivationKind, message: MailWorkspaceMessage) => {
    if (composerBusy() || derivedDraft().loading()) return;
    const selectionKey = props.selectionKey;
    const generation = readerMailboxGeneration;
    const identities = props.identities.filter((identity) => identity.status === "verified");
    const defaultIdentity = identities.find((identity) => identity.isDefault) ?? identities[0];
    if (!defaultIdentity) return explainSenderUnavailable();
    const choice = await prompts.dialog<Omit<DeriveDraftFromMessageInput, "idempotencyKey">>(
      (close) => {
        const [senderIdentityId, setSenderIdentityId] = createSignal(defaultIdentity.id);
        const [includeAttachments, setIncludeAttachments] = createSignal(message.attachments.length > 0);
        return (
          <div class="flex flex-col gap-3">
            <p class="text-sm text-secondary">{t().deriveDescription}</p>
            <Select
              label={t().sendFrom}
              value={senderIdentityId}
              onValueChange={setSenderIdentityId}
              options={identities.map((identity) => ({ id: identity.id, label: identity.label }))}
            />
            <Show when={message.attachments.length > 0}>
              <CheckboxCard
                label={t().includeAttachments({ count: message.attachments.length })}
                value={includeAttachments}
                onValueChange={setIncludeAttachments}
              />
            </Show>
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() =>
                  close({
                    kind,
                    senderIdentityId: senderIdentityId(),
                    includeAttachments: includeAttachments(),
                  })
                }
              >
                <i class="ti ti-file-pencil" aria-hidden="true" /> {t().continue}
              </Button>
            </div>
          </div>
        );
      },
      {
        title: t().useAsNew,
        icon: "ti ti-copy",
        size: "small",
      },
    );
    if (
      choice &&
      !disposed &&
      generation === readerMailboxGeneration &&
      selectionKey === props.selectionKey &&
      props.messages.some((current) => current.id === message.id)
    ) {
      derivedDraft().mutate({ message, input: choice });
    }
  };

  let currentSelection = props.selectionKey;
  let currentMessageIds = new Set(props.messages.map((message) => message.id));
  const restoreHistorySelection = (nextSelection: string | null, nextMessageIds: Set<string>) => {
    if (currentSelection && historyScroller) {
      rememberReaderState(currentSelection, historyScroller.scrollTop, expandedMessages());
    }
    currentSelection = nextSelection;
    currentMessageIds = nextMessageIds;
    const savedExpanded = nextSelection ? expandedBySelection.get(nextSelection) : null;
    const targetMessageId = selectedHistoryMessageId();
    setExpandedMessages(
      savedExpanded
        ? new Set([...savedExpanded].filter((messageId) => nextMessageIds.has(messageId)))
        : new Set(targetMessageId ? [targetMessageId] : []),
    );
    setMessageSelections({});
    setShownAttachment(null);
    setPendingNewMessages(0);
    setShowOlder(Boolean(nextSelection && olderShownBySelection.has(nextSelection)));
    followingNewest = true;
    const savedScrollTop = nextSelection ? scrollPositions.get(nextSelection) : undefined;
    scheduleReaderScroll({
      selectionKey: nextSelection,
      messageId: savedScrollTop === undefined ? targetMessageId : undefined,
      scrollTop: savedScrollTop,
    });
  };

  const applyAddedMessages = (selectionKey: string | null, nextMessageIds: Set<string>) => {
    const previousMessageCount = currentMessageIds.size;
    const addedMessages = props.messages.filter((message) => !currentMessageIds.has(message.id));
    currentMessageIds = nextMessageIds;
    if (addedMessages.length === 0) return;
    const targetMessageId = previousMessageCount === 0 ? initialConversationMessageId(props.messages) : props.messages.at(-1)?.id;
    if (!targetMessageId) return;
    if (!followingNewest) {
      setPendingNewMessages((current) => current + addedMessages.length);
      return;
    }
    setExpandedMessages((current) => new Set(current).add(targetMessageId));
    setPendingNewMessages(0);
    scheduleReaderScroll({ selectionKey, messageId: targetMessageId });
  };

  let readerMailboxId = props.mailboxId;
  createEffect(() => {
    const mailboxChanged = props.mailboxId !== readerMailboxId;
    readerMailboxId = props.mailboxId;
    const nextSelection = props.selectionKey;
    const nextMessageIds = new Set(props.messages.map((message) => message.id));
    if (mailboxChanged) {
      ++readerMailboxGeneration;
      cancelReaderWork();
      scrollPositions.clear();
      expandedBySelection.clear();
      olderShownBySelection.clear();
      foldBoundaries.clear();
      olderPinnedFor = null;
      currentSelection = null;
      restoreHistorySelection(nextSelection, nextMessageIds);
      return;
    }
    if (nextSelection !== currentSelection) {
      restoreHistorySelection(nextSelection, nextMessageIds);
      return;
    }
    applyAddedMessages(nextSelection, nextMessageIds);
  });

  onMount(() => {
    scheduleReaderScroll({ selectionKey: props.selectionKey, messageId: initialMessageId });
  });

  const cancelReaderWork = () => {
    cleanupPrint?.();
    if (readerScrollFrame !== null) cancelAnimationFrame(readerScrollFrame);
    readerScrollFrame = null;
    summarySave().abort();
    derivedDraft().abort();
  };
  onCleanup(() => {
    disposed = true;
    ++readerMailboxGeneration;
    cancelReaderWork();
  });

  const startQuoteReply = (message: MailWorkspaceMessage, body: HTMLElement) => {
    const selection = window.getSelection();
    const selectedInFrame = messageSelections()[message.id]?.trim() ?? "";
    const hostSelection = selection?.toString().trim() ?? "";
    const selectedInBody = selection?.anchorNode && body.contains(selection.anchorNode) ? hostSelection : "";
    const text = selectedInBody || selectedInFrame;
    if (!text) {
      return prompts.error(t().quoteSelectionFirst, {
        title: t().quoteInReply,
      });
    }
    const quote = quoteReplyBody(message, text, props.dateConfig, locale());
    startComposer("reply", message, quote);
  };

  const printConversation = () => {
    cleanupPrint?.();
    const root = document.body;
    const printSelection = props.selectionKey;
    const expandedBeforePrint = expandedMessages();
    let active = true;
    let frame: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (!active) return;
      active = false;
      // One update, so the fold never sees every message expanded without the print.
      batch(() => {
        setPrinting(false);
        if (props.selectionKey === printSelection) setExpandedMessages(expandedBeforePrint);
      });
      root.classList.remove("mail-printing-conversation");
      window.removeEventListener("afterprint", cleanup);
      if (timeout) clearTimeout(timeout);
      if (frame !== null) cancelAnimationFrame(frame);
      if (cleanupPrint === cleanup) cleanupPrint = null;
    };
    cleanupPrint = cleanup;
    batch(() => {
      setPrinting(true);
      setExpandedMessages(new Set(props.messages.map((message) => message.id)));
    });
    root.classList.add("mail-printing-conversation");
    window.addEventListener("afterprint", cleanup, { once: true });
    timeout = setTimeout(cleanup, 60_000);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (active) window.print();
      });
    });
  };

  /** The newest message a reply can answer; a message still on its way is not one. */
  const answerableMessage = () =>
    props.messages.findLast((message) => !message.delivery || messageDeliveryAllowsResponses(message.delivery.state)) ?? latestMessage();
  /** The reply box stands under every conversation a person can write in, also while a reply is on its way. */
  const canRespondToLatest = () => Boolean(props.canWrite && props.selectedConversationId && latestMessage());

  const canReplyAllToLatest = () => {
    const message = answerableMessage();
    return Boolean(message && deriveReplyRecipients(message, "reply_all", props.identities).cc.length > 0);
  };

  const canSplitConversation = () => props.canWrite && props.mailboxWide && (props.totalMessageCount > 1 || props.messages.length > 1);

  const keptLabel = (): string | null => {
    const keep = props.keep;
    if (!keep) return null;
    const since = t().keptSince({ name: keep.keptBy.displayName, date: dates.formatDate(keep.keptAt, props.dateConfig) });
    return keep.canLift ? since : `${since}. ${t().keptOnlyCloudAdmins}`;
  };
  // Cloud refuses these for a kept conversation; the reader says so instead of offering them.
  const keptBlocks = (actionId: MailActionId): string | null => {
    if (!props.keep) return null;
    if (actionId === "trash") return t().keptCannotDelete;
    if (actionId === "junk") return t().keptCannotJunk;
    return null;
  };
  const keepAction = (): { label: string; icon: string; description?: string; disabled: boolean; action: () => void } | null => {
    // Only a Cloud administrator can stop keeping; everyone else sees the lock and its hint, never a dead action.
    if (props.keep) {
      return props.keep.canLift
        ? { label: t().stopKeeping, icon: "ti ti-lock-open", disabled: props.structurePending, action: () => void props.onStopKeeping() }
        : null;
    }
    return props.canWrite
      ? { label: t().keep, icon: "ti ti-lock", disabled: props.structurePending, action: () => void props.onKeep() }
      : null;
  };

  const toggleCompletion = () => props.onSetCompletion(props.workStatus === "done" ? "open" : "done");

  const respondToLatest = (intent: MailRespondIntent, target?: Window) => {
    // "Reply in a new window" became "Open in a window" in the reply box; a window opened for it closes again.
    target?.close();
    if (!canRespondToLatest() || !replyBox) return;
    replyBox.open(intent);
    scrollToReplyBox();
  };
  const respond = (intent: MailRespondIntent) => respondToLatest(intent);

  // A row's Reply waits until its conversation is open here; a request for another conversation lapses.
  createEffect(() => {
    const request = props.respondRequest;
    if (!request) return;
    // A conversation that could not load answers nothing; its window closes again.
    if (props.error && request.conversationId === props.selectedConversationId) {
      props.onRespondRequestHandled();
      request.window?.close();
      return;
    }
    if (request.conversationId !== props.selectedConversationId || !latestMessage()) {
      if (request.conversationId !== props.selectedConversationId) {
        props.onRespondRequestHandled();
        request.window?.close();
      }
      return;
    }
    props.onRespondRequestHandled();
    untrack(() => respondToLatest(request.intent, request.window ?? undefined));
  });
  onCleanup(() => {
    const request = props.respondRequest;
    if (!request) return;
    props.onRespondRequestHandled();
    request.window?.close();
  });

  createEffect(() => {
    const conversationId = props.selectedConversationId;
    if (!conversationId || !canRespondToLatest() || composerBusy()) return;
    for (const intent of ["reply", "reply_all", "forward"] as const) {
      if (intent === "reply_all" && !canReplyAllToLatest()) continue;
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `mail.${conversationId}.${intent}`,
          title: intent === "reply" ? t().reply : intent === "reply_all" ? t().replyAll : t().forward,
          description: mailCommandMessages
            .resolve([locale()])
            .t[intent === "reply_all" ? "replyAllDescription" : intent === "reply" ? "replyDescription" : "forwardDescription"]({
              subject: props.subject || t().noSubject,
            }),
          icon: intent === "forward" ? "ti ti-arrow-forward-up" : "ti ti-arrow-back-up",
          ...(intent === "reply" ? { shortcut: "r" } : {}),
          action: () => respondToLatest(intent),
        }),
      );
    }
  });

  const keepMenuItem = (): DropdownAction[] => {
    const keep = keepAction();
    if (!keep) return [];
    return [
      keep.disabled && keep.description
        ? { label: keep.label, icon: keep.icon, description: keep.description, disabled: true }
        : { label: keep.label, icon: keep.icon, disabled: keep.disabled, action: keep.action },
    ];
  };

  const cloudId = useMailCloudId();
  const conversationState = createMailConversationState({
    mailboxId: () => props.mailboxId,
    conversationId: () => props.selectedConversationId,
    collaboration: () => props.collaboration,
    reminder: () => props.reminder,
    assignableUsers: () => props.assignableUsers,
    onCollaborationChange: props.onCollaborationChange,
    onReconcile: props.onReconcile,
  });
  const links = createMailConversationLinks({
    mailboxId: () => props.mailboxId,
    conversationId: () => props.selectedConversationId,
    requestUrl: () => props.requestUrl,
    subject: () => props.subject,
    enabled: () => props.mailboxWide,
    canWrite: () => props.canWrite,
  });
  const snoozedUntil = () => conversationState.state()?.snoozedUntil ?? null;
  /** Asks for a time; the form starts at the value set now. */
  const askTime = async (title: string, label: string, current: string | null): Promise<string | null> => {
    const selectionKey = props.selectionKey;
    const values = await prompts.form({
      title,
      icon: "ti ti-clock",
      fields: { at: { type: "datetime", label, required: true, default: current ?? undefined } },
    });
    return values?.at && !disposed && selectionKey === props.selectionKey ? String(values.at) : null;
  };
  const showLater = async () => {
    const until = await askTime(readerText().laterTitle, readerText().laterField, snoozedUntil());
    if (until) conversationState.snooze(until);
  };
  const remindMe = async () => {
    const due = await askTime(readerText().reminderTitle, readerText().reminderField, conversationState.reminderDueAt());
    if (due) conversationState.setReminder(due);
  };
  // "Later": the conversation comes back at a time for everyone; the reminder reaches only you.
  const laterItems = (): DropdownItem[] => {
    const until = snoozedUntil() && Date.parse(snoozedUntil()!) > Date.now() ? snoozedUntil() : null;
    const done = props.workStatus === "done";
    return [
      ...(props.canWrite && props.collaboration
        ? [
            {
              items: [
                { label: readerText().showLater, icon: "ti ti-clock", disabled: done, action: () => void showLater() },
                ...(until ? [{ label: readerText().showNow, icon: "ti ti-clock-off", action: () => conversationState.snooze(null) }] : []),
              ],
            },
          ]
        : []),
      {
        sectionLabel: readerText().reminderOnlyForYou,
        items: [
          {
            label: conversationState.reminderDueAt() ? readerText().changeReminder : readerText().remindMe,
            icon: "ti ti-bell",
            action: () => void remindMe(),
          },
          ...(conversationState.reminderDueAt()
            ? [{ label: readerText().removeReminder, icon: "ti ti-bell-off", action: () => conversationState.setReminder(null) }]
            : []),
        ],
      },
    ];
  };
  const linkItems = (): DropdownAction[] =>
    links.canLink()
      ? [
          { label: readerText().createTask, icon: "ti ti-checkbox", action: () => void links.create("task") },
          { label: readerText().createEvent, icon: "ti ti-calendar-event", action: () => void links.create("event") },
          { label: readerText().linkExisting, icon: "ti ti-link-plus", action: () => void links.linkExisting() },
          ...links.items().map((item) => ({
            label: readerText().unlinkNamed({ name: item.title }),
            icon: "ti ti-unlink",
            action: () => void links.unlink(item.id),
          })),
        ]
      : [];
  const showActivity = () =>
    void openMailActivityDialog({
      activity: props.activity,
      unavailable: Boolean(props.detailErrors.activity),
      onRetry: () => void props.onReconcile(),
      dateConfig: props.dateConfig,
      locale: locale(),
    });
  const copyReference = () => {
    const reference = props.reference;
    if (!reference) return;
    void navigator.clipboard.writeText(reference).then(
      () => toast.success(t().referenceCopied),
      () => toast.error(t().referenceCopyFailed),
    );
  };
  const emlItem = (): DropdownAction[] => {
    const message = latestMessage();
    return message?.sourceAvailable
      ? [
          {
            label: t().downloadEml,
            icon: "ti ti-download",
            href: `/api/mail/mailboxes/${props.mailboxId}/messages/${message.id}/source`,
          },
        ]
      : [];
  };
  // The same menu as the conversation's row in the list, with what only the open conversation knows. Every action of
  // the head stays here too, so a narrow head that hides some never loses them.
  const overflowActions = (): DropdownItem[] =>
    mailConversationMenuItems({
      t: t(),
      ...(canRespondToLatest() ? { respond: { replyAll: canReplyAllToLatest(), disabled: composerBusy(), run: respond } } : {}),
      ...(props.canWrite
        ? {
            ...(props.assignment
              ? {
                  assignToMe: {
                    assigned: props.assignment.assigned,
                    others: props.assignment.others,
                    disabled: props.automationPending,
                    run: () => void props.onAssignConversationToMe(),
                  },
                }
              : {}),
            ...(props.workStatus
              ? { completion: { done: props.workStatus === "done", disabled: props.completionPending, run: toggleCompletion } }
              : {}),
            followUp: [
              ...(props.assignment
                ? [
                    {
                      label: readerText().assign,
                      icon: "ti ti-user-plus",
                      disabled: props.actionPending,
                      action: () => void props.onAssignConversation(),
                    },
                  ]
                : []),
              ...(props.collaboration
                ? [
                    {
                      label: readerText().showLater,
                      icon: "ti ti-clock",
                      disabled: props.workStatus === "done",
                      action: () => void showLater(),
                    },
                  ]
                : []),
            ],
            organize: {
              unread: props.unread,
              flagged: props.flagged,
              spamAction: props.inJunk ? ("not_spam" as const) : ("junk" as const),
              kept: Boolean(props.keep),
              disabled: props.actionPending,
              tagsDisabled: props.structurePending,
              run: (actionId: MailActionId) => void props.onAction(actionId),
              manageTags: () => void props.onManageTags(),
            },
            conversation: [
              {
                label: props.conversationSummary?.summary ? t().editSummary : t().createSummary,
                icon: "ti ti-notes",
                disabled: summarySaving() || !props.conversationSummary,
                action: () => void editConversationSummary(),
              },
              ...(props.conversationSummary?.canGenerate && !props.conversationSummary.summary
                ? [
                    {
                      label: summaryText().summarizeWithAi,
                      icon: "ti ti-sparkles",
                      disabled: summaryGenerate().loading() || props.conversationSummary.status === "writing",
                      action: () => generateSummary("replace"),
                    },
                  ]
                : []),
              ...(props.mailboxWide
                ? [
                    {
                      label: t().mergeWithConversation,
                      icon: "ti ti-git-merge",
                      disabled: props.structurePending,
                      action: props.onMergeConversation,
                    },
                  ]
                : []),
              ...(canSplitConversation() && latestMessage()
                ? [
                    {
                      label: t().splitLatest,
                      icon: "ti ti-arrows-split-2",
                      disabled: props.structurePending,
                      action: () => {
                        const message = latestMessage();
                        if (message) void props.onSplitMessage(message.id);
                      },
                    },
                  ]
                : []),
              ...keepMenuItem(),
            ],
            link: linkItems(),
          }
        : {}),
      other: [
        { label: readerText().showActivity, icon: "ti ti-activity", action: showActivity },
        { label: t().printConversation, icon: "ti ti-printer", action: printConversation },
        ...(props.reference ? [{ label: t().copyReference, icon: "ti ti-hash", immediate: true, action: copyReference }] : []),
        ...emlItem(),
        ...cloudId.actions({ conversationId: props.selectedConversationId }),
      ],
    });
  const readerHint = (): MailReaderHint | null => {
    if (!props.selectedConversationId) return null;
    if (props.toolbarCustomized && !props.hintSeen("toolbar-moved")) return "toolbar-moved";
    return props.hintSeen("reader-head-moved") ? null : "reader-head-moved";
  };
  /** The person outside the team in this conversation, named in the internal note's "… never sees it". */
  const customerName = (): string | null => {
    const own = new Set(props.identities.map((identity) => identity.fromAddress.trim().toLowerCase()));
    for (const message of props.messages) {
      const sender = message.from[0];
      if (sender && !own.has(sender.address.trim().toLowerCase())) return sender.name || sender.address;
    }
    return null;
  };
  const senderLabel = () => {
    const first = props.messages[0]?.from[0];
    return first?.name || first?.address || t().unknownSender;
  };

  return (
    <div
      class="mail-reader flex h-full min-h-0 flex-col overflow-hidden"
      data-mail-print-root
      data-print-region={printing() ? "" : undefined}
    >
      <Show when={props.error}>
        {(error) => {
          const message = error();
          return (
            <Placeholder
              state="error"
              variant="panel"
              title={t().couldNotLoadMessage}
              description={message}
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => void props.onReconcile()}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              }
            />
          );
        }}
      </Show>
      <Show when={!props.error && props.totalMessageCount > props.messages.length}>
        <NoticeCard tone="warning" class="mx-3 mt-3" role="status">
          {t().longConversation({ shown: props.messages.length, total: props.totalMessageCount })}
        </NoticeCard>
      </Show>
      <Show
        when={props.messages.length > 0}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center p-[var(--ui-space-shell)]">
            <Placeholder icon="ti ti-mail-opened" title={t().chooseConversationTitle} description={t().chooseConversationDescription} />
          </div>
        }
      >
        {/* A right-click anywhere in the conversation opens its "…" menu; a message opens its own. Links, fields, the
            message bodies, and selected text keep the browser's menu. */}
        <ContextMenu
          class="flex min-h-0 flex-1 flex-col"
          tabIndex={-1}
          items={overflowActions()}
          label={t().moreConversationActions}
          keepNativeMenu
        >
          <MailReaderHead
            subject={props.subject}
            noSubject={t().noSubject}
            flagged={props.flagged}
            flaggedLabel={t().flaggedConversation}
            closeHref={closeHref()}
            onClose={props.onClose}
            canWrite={props.canWrite}
            dateConfig={props.dateConfig}
            workStatus={props.workStatus}
            completionPending={props.completionPending}
            onToggleCompletion={toggleCompletion}
            actionPending={props.actionPending}
            deleteBlocked={keptBlocks("trash")}
            onArchive={() => void props.onAction("archive")}
            onDelete={() => void props.onAction("trash")}
            snoozedUntil={snoozedUntil()}
            reminderDueAt={conversationState.reminderDueAt()}
            assignees={props.assignment ? (conversationState.state()?.assignees ?? []) : null}
            onAssign={() => void props.onAssignConversation()}
            keep={props.keep}
            keptTitle={keptLabel()}
            onStopKeeping={props.keep?.canLift ? () => void props.onStopKeeping() : null}
            tags={props.tags}
            onManageTags={props.canWrite ? () => void props.onManageTags() : null}
            linked={{ items: links.items(), state: links.state(), retry: () => void links.retry(), enabled: props.mailboxWide }}
            senderLabel={senderLabel()}
            messageCount={Math.max(props.totalMessageCount, props.messages.length)}
            presence={props.presence}
            currentUserId={props.currentUserId}
            laterItems={laterItems}
            menuItems={overflowActions}
            menuLabel={t().moreConversationActions}
            hint={readerHint()}
            onHintSeen={props.onHintSeen}
          />

          <div class="relative min-h-0 flex-1 overflow-hidden">
            <ScrollArea
              ref={historyScroller}
              class="mail-reader-scroll absolute inset-0 px-3 py-2 sm:px-5"
              scrollPreserveKey={`mail-reader-${props.selectionKey}`}
              onScroll={handleReaderScroll}
            >
              <div class="mail-reading-column" data-mail-reading-column>
                <MailAutomationTrace
                  items={props.automationTrace}
                  where="top"
                  canWrite={props.canWrite}
                  whyHref={automationWhyHref}
                  timeZone={props.dateConfig.timeZone}
                  orderHref={automationOrderHref()}
                  onUndo={(item) => void props.onUndoAutomation(item)}
                  onAssign={() => void props.onAssignConversation()}
                  onAssignToMe={() => void props.onAssignConversationToMe()}
                  busy={props.automationPending}
                />
                <Show when={showsConversationSummary(props.conversationSummary) && props.conversationSummary}>
                  {(state) => (
                    <MailConversationSummaryCard
                      state={state()}
                      canEdit={props.canWrite}
                      editDisabled={summarySaving()}
                      onEdit={() => void editConversationSummary()}
                      onGenerate={generateSummary}
                      onRemind={(due) => conversationState.setReminder(due)}
                      generating={summaryGenerate().loading()}
                    />
                  )}
                </Show>
                <Show when={describeUnavailableMailDetails({ ...props.detailErrors, comments: null, activity: null }, locale())}>
                  {(description) => (
                    <Placeholder
                      state="error"
                      variant="compact"
                      align="left"
                      title={description()}
                      onRetry={() => void props.onReconcile()}
                    />
                  )}
                </Show>
                <div class="mail-timeline" data-mail-conversation-messages>
                  <Show when={olderMessages()}>
                    {(older) => (
                      <button
                        type="button"
                        class="mail-reader-older"
                        data-mail-older-messages
                        onClick={() => revealOlderMessages(older().start)}
                      >
                        <i class="ti ti-dots" aria-hidden="true" />
                        {t().olderMessages({ count: older().count })}
                      </button>
                    )}
                  </Show>
                  <Show when={!olderMessages() && (notes.hasEarlier() || notes.earlierError())}>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      class="mail-timeline-earlier"
                      data-mail-earlier-notes
                      loading={notes.loadingEarlier()}
                      onClick={() => void notes.loadEarlier()}
                    >
                      <i class={notes.earlierError() ? "ti ti-refresh" : "ti ti-note"} aria-hidden="true" />
                      {notes.earlierError() ? `${notes.earlierError()} · ${t().retry}` : readerText().earlierNotes}
                    </Button>
                  </Show>
                  <Show when={Boolean(props.detailErrors.comments)}>
                    <p class="mail-timeline-unavailable" role="status">
                      <i class="ti ti-note-off" aria-hidden="true" />
                      {readerText().notesUnavailable}
                      <Button type="button" size="xs" variant="ghost" onClick={() => void props.onReconcile()}>
                        {t().retry}
                      </Button>
                    </p>
                  </Show>
                  <For each={visibleTimelineIds()}>
                    {(id) => {
                      const item = () => timelineItems().get(id);
                      const noteItem = () => {
                        const current = item();
                        return current?.kind === "note" ? current.note : undefined;
                      };
                      const messageItem = () => {
                        const current = item();
                        return current?.kind === "message" ? current.message : undefined;
                      };
                      return (
                        <>
                          <Show when={noteItem()}>
                            {(note) => (
                              <MailConversationNote
                                note={note()}
                                dateConfig={props.dateConfig}
                                saving={notes.saving()}
                                onSave={notes.save}
                                onDelete={notes.remove}
                              />
                            )}
                          </Show>
                          <Show when={messageItem()}>
                            {(message) => (
                              <MailMessageCard
                                message={message()}
                                expanded={expandedMessages().has(message().id)}
                                isLatest={props.messages.at(-1)?.id === message().id}
                                selectionAvailable={Boolean(messageSelections()[message().id])}
                                context={{
                                  mailboxId: props.mailboxId,
                                  requestUrl: props.requestUrl,
                                  canWrite: props.canWrite,
                                  canAdmin: props.canAdmin,
                                  mailboxWide: props.mailboxWide,
                                  selectionKey: props.selectionKey,
                                  selectedConversationId: props.selectedConversationId,
                                  totalMessageCount: props.totalMessageCount,
                                  identities: props.identities,
                                  dateConfig: props.dateConfig,
                                  readingFormat: props.readingFormat,
                                  theme: printing() ? "light" : props.theme,
                                  calendarIntegrationAvailable: props.calendarIntegrationAvailable,
                                  composerBusy: composerBusy(),
                                  subject: props.subject,
                                  messages: props.messages,
                                }}
                                actions={{
                                  toggle: toggleMessage,
                                  selectionChange: (messageId, value) =>
                                    setMessageSelections((current) => {
                                      if (value)
                                        return current[messageId] === value && Object.keys(current).length === 1
                                          ? current
                                          : { [messageId]: value };
                                      if (!(messageId in current)) return current;
                                      const next = { ...current };
                                      delete next[messageId];
                                      return next;
                                    }),
                                  compose: startComposer,
                                  quoteReply: startQuoteReply,
                                  derive: (kind, selectedMessage) => {
                                    void deriveMessage(kind, selectedMessage);
                                  },
                                  reconcile: props.onReconcileAfterWrite,
                                  refresh: props.onReconcile,
                                  reassign: props.onReassignMessage,
                                  split: props.onSplitMessage,
                                  openDraft: (draftId) => {
                                    replyBox?.openDraft(draftId);
                                    scrollToReplyBox();
                                  },
                                  openAttachment,
                                }}
                              />
                            )}
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </div>
                <Show when={props.automationTrace.length > 0}>
                  <MailAutomationTrace
                    items={props.automationTrace}
                    where="bottom"
                    canWrite={props.canWrite}
                    whyHref={automationWhyHref}
                    timeZone={props.dateConfig.timeZone}
                    orderHref={automationOrderHref()}
                    onUndo={(item) => void props.onUndoAutomation(item)}
                    onAssign={() => void props.onAssignConversation()}
                    onAssignToMe={() => void props.onAssignConversationToMe()}
                    busy={props.automationPending}
                  />
                </Show>
                {/* The reply box stands open under the newest message (Mail v5): one reply draft per conversation, and the
                    internal note. It belongs to its conversation; another conversation gets a box of its own. */}
                <Show when={canRespondToLatest() ? props.selectedConversationId : null} keyed>
                  {(conversationId) => (
                    <MailReplyBox
                      mailboxId={props.mailboxId}
                      conversationId={conversationId}
                      subject={props.subject}
                      messages={props.messages}
                      conversationDrafts={props.conversationDrafts}
                      identities={props.identities}
                      canReplyAll={canReplyAllToLatest()}
                      customerName={customerName()}
                      currentUserId={props.currentUserId ?? ""}
                      currentUserEmail={props.currentUserEmail ?? null}
                      dateConfig={props.dateConfig}
                      canAdmin={props.canAdmin}
                      mailboxRecipientSuggestions={props.mailboxWide}
                      calendarIntegrationAvailable={props.calendarIntegrationAvailable}
                      liveDictation={props.liveDictation ?? false}
                      returnHref={props.requestUrl}
                      messageLabel={(messageId) => {
                        const message = props.messages.find((candidate) => candidate.id === messageId);
                        if (!message) return null;
                        const sender = message.from[0];
                        const name = sender?.name || sender?.address || "";
                        return `${name}, ${dates.formatDateTimeRelative(message.internalDate, props.dateConfig)}`;
                      }}
                      createNote={notes.create}
                      onReconcile={props.onReconcileAfterWrite}
                      onExplainSenderUnavailable={() => void explainSenderUnavailable()}
                      register={(api) => {
                        replyBox = api;
                        onCleanup(() => {
                          if (replyBox === api) replyBox = null;
                        });
                      }}
                    />
                  )}
                </Show>
              </div>
            </ScrollArea>
            <Show when={pendingNewMessages()}>
              {(count) => (
                <Button size="sm" type="button" class="mail-reader-new-below" aria-live="polite" onClick={jumpToNewest}>
                  {readerText().newBelow({ count: count() })}
                  <i class="ti ti-arrow-down" aria-hidden="true" />
                </Button>
              )}
            </Show>
          </div>
          <Show when={shownAttachment() !== null && lightboxItems().length > 0}>
            <Lightbox
              items={lightboxItems()}
              index={shownAttachment() ?? 0}
              onIndexChange={setShownAttachment}
              onClose={() => setShownAttachment(null)}
            />
          </Show>
        </ContextMenu>
      </Show>
    </div>
  );
}
