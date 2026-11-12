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
  IconButton,
  Lightbox,
  NoticeCard,
  Placeholder,
  prefersReducedMotion,
  prompts,
  ScrollArea,
  Select,
  Toolbar,
  Tooltip,
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
  MailDraft,
  MailDraftSeed,
  SenderIdentity,
} from "../../contracts";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import { deriveReplyAddressObjects } from "../../reply-recipients";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "../../service/collaboration";
import type { ConversationKeep } from "../../service/conversation-keeps";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import type { LocalTag } from "../../service/local-tags";
import type { ConversationPresenceParticipant } from "../../service/presence";
import type { ConversationReminder } from "../../service/reminders";
import type { MailDetailErrors, MailWorkspaceMessage } from "../../service/workspace";
import { automationLogHref } from "../automation-log-href";
import { readApiError, readApiFailure } from "./api-response";
import { openMailActivityDialog } from "./MailActivityDialog";
import MailAutomationTrace from "./MailAutomationTrace";
import type { MailInlineDraftControls } from "./MailComposer";
import MailConversationNote from "./MailConversationNote";
import MailConversationSummaryCard, { type MailSummaryGenerateMode, showsConversationSummary } from "./MailConversationSummaryCard";
import MailInlineDraft from "./MailInlineDraft";
import { attachmentLightboxItem } from "./MailMessageAttachments";
import MailMessageCard from "./MailMessageCard";
import MailReaderHead, { type MailReaderHint } from "./MailReaderHead";
import type { MailActionId } from "./mail-actions";
import { useMailCloudId } from "./mail-cloud-id";
import {
  deriveReplyIdentityId,
  deriveReplyRecipients,
  forwardMessageBody,
  forwardSubject,
  quoteReplyBody,
  replySubject,
} from "./mail-compose-derivation";
import { mailDraftHref, mailDraftSeedHref } from "./mail-compose-route";
import { initialConversationMessageId, isNearConversationEnd } from "./mail-conversation-history";
import { createMailConversationLinks } from "./mail-conversation-links";
import { type MailRespondIntent, type MailRespondRequest, mailConversationMenuItems, openMailReplyWindow } from "./mail-conversation-menu";
import { createMailConversationNotes } from "./mail-conversation-notes";
import { createMailConversationState } from "./mail-conversation-state";
import { buildMailConversationTimeline } from "./mail-conversation-timeline";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { describeUnavailableMailDetails } from "./mail-detail-availability";
import { captureMailDraftMorph, playMailDraftClose, playMailDraftOpen } from "./mail-draft-morph";
import { createRetryToasts } from "./mail-feedback";
import { messageDeliveryAllowsResponses } from "./mail-message-presentation";
import { buildMailListHref, mailRouteUrl } from "./mail-navigation";
import { mailReaderMessages } from "./mail-reader-messages";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "./mail-sender-identity-status";
import { mailSummaryMessages } from "./mail-summary-messages";
import type { MailReadingFormat } from "./mail-user-preferences";
import { captureMailWorkspaceRefreshError } from "./mail-workspace-refresh";

type MailConversationComposerRequest = {
  intent: DraftIntent;
  message: MailWorkspaceMessage;
  quotedBody?: string;
  /** The window the click opened for the draft; it closes again when no draft opens. */
  window?: Window;
};

type DraftLookup = {
  conversationId: string;
  request: MailConversationComposerRequest;
  generation: number;
};

type InlineDraftState = {
  conversationId: string;
  draftId: string;
  /** The draft as the click that created it received it. */
  initialDraft?: MailDraft;
  /** Created by this click: collapsing it unchanged discards it again. */
  fresh: boolean;
};

/**
 * The reply pill's actions after Reply, in order: Reply all and Forward. Done and Assign stand in the head (Mail v5),
 * so the pill at the end of the conversation only answers. Change only this list.
 */
const REPLY_PILL_ACTIONS = ["reply_all", "forward"] as const;
type ReplyPillActionId = (typeof REPLY_PILL_ACTIONS)[number];
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
  const intentLabel = (intent: DraftIntent): string =>
    intent === "reply"
      ? t().replyIntent
      : intent === "reply_all"
        ? t().replyAllIntent
        : intent === "forward"
          ? t().forwardIntent
          : t().messageIntent;
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
  let closeDraftDialog: ((value: ConversationDraftSummary | undefined) => void) | null = null;
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

  const isCurrentLookup = (lookup: DraftLookup) =>
    !disposed && lookup.generation === readerMailboxGeneration && props.selectedConversationId === lookup.conversationId;

  /** Ends a draft lookup that opens no draft: the window it opened closes again. */
  const dropWindow = (lookup: DraftLookup | undefined) => lookup?.request.window?.close();
  /** Opens a draft here, or in the lookup's own window while this one stays on the conversation. */
  const openDraftPage = (lookup: DraftLookup | undefined, href: (popout: boolean) => string) => {
    const target = lookup?.request.window;
    if (!target) return documentNavigate(href(false));
    target.location.replace(href(true));
  };

  const openConversationDraft = (lookup: DraftLookup, draftId: string) => {
    if (!isCurrentLookup(lookup)) return dropWindow(lookup);
    openDraftPage(lookup, (popout) => mailDraftHref(props.mailboxId, draftId, props.requestUrl, { popout }));
  };

  const openDraftSeed = async (seed: MailDraftSeed, stillCurrent: () => boolean, lookup?: DraftLookup) => {
    const store = await importOnDemand(() => import("./mail-draft-seed-store"));
    if (!store || disposed || !stillCurrent()) return dropWindow(lookup);
    try {
      if (!seedStorage) throw new Error(t().localDraftFailed);
      store.storeMailDraftSeed(seedStorage, seed);
    } catch {
      dropWindow(lookup);
      void prompts.error(t().localDraftFailed, {
        title: t().startMessageFailed,
      });
      return;
    }
    openDraftPage(lookup, (popout) => mailDraftSeedHref(props.mailboxId, seed.id, props.requestUrl, { popout }));
  };

  const chooseConversationDraft = async (lookup: DraftLookup, existingDrafts: ConversationDraftSummary[]) => {
    if (!isCurrentLookup(lookup)) return dropWindow(lookup);
    if (existingDrafts.length === 0) return void createConversationDraft(lookup);
    const selected = await prompts.dialog<ConversationDraftSummary>(
      (close) => {
        closeDraftDialog = close;
        createEffect(() => {
          if (!isCurrentLookup(lookup)) close(undefined);
        });
        return (
          <div class="flex min-h-0 flex-col gap-3">
            <p class="text-sm text-secondary">{t().existingDrafts({ count: existingDrafts.length })}</p>
            <ScrollArea class="flex max-h-[55vh] flex-col gap-2">
              <For each={existingDrafts}>
                {(existingDraft) => (
                  <button
                    type="button"
                    class="group flex min-w-0 items-start gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-left hover:bg-[var(--ui-hover)]"
                    onClick={() => close(existingDraft)}
                  >
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] text-dimmed">
                      <i class="ti ti-file-pencil" aria-hidden="true" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                          {existingDraft.subject || t().noSubject}
                        </span>
                        <span class="shrink-0 text-xs font-medium text-secondary group-hover:text-primary">{t().continue}</span>
                      </span>
                      <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dimmed">
                        <span>
                          <i class="ti ti-user mr-1" aria-hidden="true" />
                          {t().createdBy({ name: existingDraft.createdByDisplayName })}
                        </span>
                        <span>
                          {intentLabel(existingDraft.intent)} ·{" "}
                          {t().updated({ value: dates.formatDateTimeRelative(existingDraft.updatedAt, props.dateConfig) })}
                        </span>
                      </span>
                      <span class="line-clamp-2 min-h-5 text-xs leading-5 text-secondary">
                        {existingDraft.bodyPreview || t().noContent}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </ScrollArea>
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
            </div>
          </div>
        );
      },
      {
        title: t().continueDraftTitle,
        icon: "ti ti-file-pencil",
        size: "large",
      },
    );
    closeDraftDialog = null;
    if (selected === undefined || !isCurrentLookup(lookup)) return dropWindow(lookup);
    void openConversationDraft(lookup, selected.id);
  };

  const conversationDrafts = createMemo(
    on(
      () => props.mailboxId,
      () => {
        let active = true;
        const current = mutations.create<ConversationDraftSummary[], DraftLookup, DraftLookup>({
          onBefore: (lookup) => lookup,
          mutation: async (lookup, { abortSignal }) => {
            if (!active) throw new DOMException("Mailbox changed", "AbortError");
            const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].drafts.$get(
              {
                param: {
                  mailboxId: props.mailboxId,
                  conversationId: lookup.conversationId,
                },
                query: { limit: "20" },
              },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(await readApiError(response, t().checkDraftsFailed));
            return response.json();
          },
          onSuccess: (existingDrafts, context) => {
            if (context) void chooseConversationDraft(context, existingDrafts);
          },
          onError: (error, context) => {
            dropWindow(context);
            void prompts.error(error.message);
          },
          onAbort: dropWindow,
        });
        onCleanup(() => {
          active = false;
          current.abort();
        });
        return current;
      },
    ),
  );

  const createdDraft = createMemo(
    on(
      () => props.mailboxId,
      () => {
        let active = true;
        const current = mutations.create<MailDraftSeed, { lookup: DraftLookup; senderIdentityId: string }, DraftLookup>({
          onBefore: ({ lookup }) => lookup,
          mutation: async ({ lookup, senderIdentityId }, { abortSignal }) => {
            if (!active) throw new DOMException("Mailbox changed", "AbortError");
            const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
              {
                param: { mailboxId: props.mailboxId },
                json: {
                  origin: {
                    kind: "compose",
                    input: {
                      senderIdentityId,
                      to: [],
                      cc: [],
                      bcc: [],
                      subject: lookup.request.intent === "forward" ? forwardSubject(props.subject) : replySubject(props.subject),
                      body: lookup.request.quotedBody ?? "",
                      conversationId: lookup.conversationId,
                      intent: lookup.request.intent,
                      sourceMessageId: lookup.request.message.id,
                      includeSourceAttachments: lookup.request.intent === "forward" && lookup.request.message.attachments.length > 0,
                    },
                  },
                },
              },
              { init: { signal: abortSignal } },
            );
            if (!response.ok) throw new Error(await readApiError(response, t().createDraftFailed));
            return response.json();
          },
          onSuccess: (seed, lookup) => {
            if (lookup && isCurrentLookup(lookup)) void openDraftSeed(seed, () => isCurrentLookup(lookup), lookup);
            else dropWindow(lookup);
          },
          onError: (error, lookup) => {
            dropWindow(lookup);
            void prompts.error(error.message, { title: t().startMessageFailed });
          },
          onAbort: dropWindow,
        });
        onCleanup(() => {
          active = false;
          current.abort();
        });
        return current;
      },
    ),
  );

  /** Names why no verified sender can send, and lets a mailbox admin open the setting that fixes it. */
  const explainSenderUnavailable = async () => {
    const generation = readerMailboxGeneration;
    const status = mailSenderIdentityStatusMessages.resolve([locale()]).t;
    const detail = senderUnavailableDetail(props.identities, locale());
    if (!props.canAdmin) return void (await prompts.error(`${detail} ${status.askAdmin}`, { title: status.cannotSend }));
    const open = await prompts.confirm(detail, { title: status.cannotSend, confirmText: status.openSenderSettings });
    if (open && !disposed && generation === readerMailboxGeneration) props.onOpenDeliverySettings();
  };

  const chooseReplyIdentity = async (lookup: DraftLookup): Promise<string | null> => {
    const identities = props.identities.filter((identity) => identity.status === "verified");
    const derived = deriveReplyIdentityId(lookup.request.message, identities);
    if (derived) return derived;
    if (identities.length === 0) {
      await explainSenderUnavailable();
      return null;
    }
    const selected = await prompts.dialog<string | null>(
      (close) => {
        const [senderIdentityId, setSenderIdentityId] = createSignal(
          identities.find((identity) => identity.isDefault)?.id ?? identities[0]!.id,
        );
        return (
          <div class="flex flex-col gap-3">
            <p class="text-sm text-secondary">{t().multipleSenders}</p>
            <Select
              label={t().from}
              value={senderIdentityId}
              onValueChange={setSenderIdentityId}
              options={identities.map((identity) => ({
                id: identity.id,
                label: identity.label,
                description: `${identity.displayName ? `${identity.displayName} · ` : ""}${identity.fromAddress}`,
              }))}
            />
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
                {t().cancel}
              </Button>
              <Button size="sm" type="button" onClick={() => close(senderIdentityId())}>
                {t().continue}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().chooseSender, icon: "ti ti-user", size: "medium" },
    );
    return selected ?? null;
  };

  const createConversationDraft = async (lookup: DraftLookup) => {
    if (!isCurrentLookup(lookup) || createdDraft().loading()) return dropWindow(lookup);
    const senderIdentityId = await chooseReplyIdentity(lookup);
    if (!senderIdentityId || !isCurrentLookup(lookup) || createdDraft().loading()) return dropWindow(lookup);
    createdDraft().mutate({ lookup, senderIdentityId });
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
  // The draft open in this conversation. Reply, undo, and a draft row open it in place of the pill; the URL keeps it.
  const initialDraftId = new URL(props.requestUrl, "http://mail.invalid").searchParams.get("draft");
  const [inlineDraft, setInlineDraft] = createSignal<InlineDraftState | null>(
    initialDraftId && props.selectedConversationId
      ? { conversationId: props.selectedConversationId, draftId: initialDraftId, fresh: false }
      : null,
  );
  const [inlineStarting, setInlineStarting] = createSignal(false);
  let inlineDraftControls: MailInlineDraftControls | null = null;
  // Full screen: once the draft scrolls out of view into the history, one fixed row keeps Send and the way back.
  const [draftOutOfView, setDraftOutOfView] = createSignal(false);
  createEffect(() => {
    const open = visibleInlineDraft();
    if (!open || !props.draftFullscreen || !historyScroller || typeof IntersectionObserver === "undefined") {
      setDraftOutOfView(false);
      return;
    }
    const frame = historyScroller.querySelector("[data-mail-inline-draft-frame]");
    if (!frame) return;
    const observer = new IntersectionObserver(([entry]) => setDraftOutOfView(!entry?.isIntersecting), { root: historyScroller });
    observer.observe(frame);
    onCleanup(() => observer.disconnect());
  });
  const backToText = () => {
    historyScroller?.querySelector("[data-mail-inline-draft-frame]")?.scrollIntoView({ block: "start" });
    inlineDraftControls?.focusText();
  };
  const visibleInlineDraft = createMemo(() => {
    const open = inlineDraft();
    return open && open.conversationId === props.selectedConversationId ? open : null;
  });
  // Suggestions someone collapsed in this reader: they wait as rows instead of opening again by themselves.
  const collapsedSuggestions = new Set<string>();
  const closeInlineDraft = (draftId: string) => {
    if (inlineDraft()?.draftId !== draftId) return;
    if (props.conversationDrafts.some((draft) => draft.id === draftId && draft.suggestion)) collapsedSuggestions.add(draftId);
    const start = historyScroller ? captureMailDraftMorph(historyScroller) : null;
    inlineDraftControls = null;
    setInlineDraft(null);
    props.onDraftChange?.(null);
    if (historyScroller && start) playMailDraftClose(historyScroller, start);
  };
  /** Opens a draft here. An open one closes first through its own safe path; if that fails, it stays open. */
  const openInlineDraft = async (next: InlineDraftState) => {
    const current = visibleInlineDraft();
    if (current?.draftId === next.draftId) return;
    if (current && inlineDraftControls) {
      await inlineDraftControls.collapse();
      if (inlineDraft()?.draftId === current.draftId) return;
    }
    if (disposed || props.selectedConversationId !== next.conversationId) return;
    const start = historyScroller ? captureMailDraftMorph(historyScroller) : null;
    inlineDraftControls = null;
    setInlineDraft(next);
    props.onDraftChange?.(next.draftId);
    // The layout already shows the draft; the motion runs from the pill's box to it.
    const frame = historyScroller?.querySelector<HTMLElement>("[data-mail-inline-draft-frame]");
    if (historyScroller && frame && start) playMailDraftOpen(historyScroller, frame, start);
  };
  // A draft belongs to its conversation: another conversation or mailbox unmounts it, and its session saves what is
  // left before it releases the lease.
  createEffect(
    on(
      () => [props.selectedConversationId, props.mailboxId] as const,
      ([conversationId]) => {
        const open = untrack(inlineDraft);
        if (open && open.conversationId !== conversationId) {
          inlineDraftControls = null;
          setInlineDraft(null);
          props.onDraftChange?.(null, { history: false });
        }
      },
      { defer: true },
    ),
  );

  /** The conversation's other drafts, newest first, as quiet rows under the open draft. */
  const otherDrafts = createMemo(() => props.conversationDrafts.filter((draft) => draft.id !== visibleInlineDraft()?.draftId));
  const draftIntentIcon = (intent: DraftIntent) =>
    intent === "reply"
      ? "ti-arrow-back-up"
      : intent === "reply_all"
        ? "ti-arrow-back-up-double"
        : intent === "forward"
          ? "ti-arrow-forward-up"
          : "ti-pencil";

  // A suggestion from Gustav is already open in the conversation, in plum, ready to edit or send. Once someone
  // collapses it, it waits as a row until someone opens it again.
  createEffect(() => {
    const conversationId = props.selectedConversationId;
    if (!conversationId || !props.canWrite || inlineDraft() || inlineStarting()) return;
    const suggestion = props.conversationDrafts.find((draft) => draft.suggestion && !collapsedSuggestions.has(draft.id));
    if (suggestion) untrack(() => void openInlineDraft({ conversationId, draftId: suggestion.id, fresh: false }));
  });

  // Back and Forward return to a conversation with its draft open: the URL names the draft, the reader opens it.
  createEffect(
    on(
      () => props.requestUrl,
      (url) => {
        const draftId = new URL(url, "http://mail.invalid").searchParams.get("draft");
        const conversationId = props.selectedConversationId;
        if (!draftId || !conversationId || untrack(inlineDraft)?.draftId === draftId) return;
        void openInlineDraft({ conversationId, draftId, fresh: false });
      },
      { defer: true },
    ),
  );

  const composerBusy = () => conversationDrafts().loading() || createdDraft().loading() || derivedDraft().loading() || inlineStarting();

  /**
   * Reply, Reply all, and Forward share the conversation's reply draft. Existing text stays when its mode changes.
   * A quoted reply opens an occupied box unchanged; inserting a selection belongs to its active editor.
   */
  const startInlineDraft = async (intent: DraftIntent, message: MailWorkspaceMessage, quotedBody?: string) => {
    const conversationId = props.selectedConversationId;
    if (!conversationId) return;
    const generation = readerMailboxGeneration;
    const stillHere = () => !disposed && generation === readerMailboxGeneration && props.selectedConversationId === conversationId;
    const param = { mailboxId: props.mailboxId };
    const openExisting = async (draftId: string) => {
      if (!stillHere()) return;
      // Save and release our active editor before the structural write; never replace its unsaved input.
      if (visibleInlineDraft()?.draftId === draftId && inlineDraftControls) {
        await inlineDraftControls.collapse({ preserveDraft: true });
        if (inlineDraft()?.draftId === draftId || !stillHere()) return;
      }
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({ param: { ...param, draftId } });
      if (!response.ok) throw new Error(await readApiError(response, t().createDraftFailed));
      let existing = await response.json();
      if (!stillHere()) return;
      if (existing.state === "draft" && intent !== "new" && existing.intent !== intent) {
        const changed = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].intent.$post({
          param: { ...param, draftId },
          json: { intent, expectedRevision: existing.revision },
        });
        if (!changed.ok) throw new Error(await readApiError(changed, t().createDraftFailed));
        existing = await changed.json();
      }
      if (!stillHere()) return;
      // A loading editor may already name this draft; refresh it with the switched snapshot.
      if (inlineDraft()?.draftId === draftId) setInlineDraft(null);
      await openInlineDraft({ conversationId, draftId, initialDraft: existing, fresh: false });
    };
    setInlineStarting(true);
    try {
      const existing = props.conversationDrafts.find((draft) => draft.intent !== "new");
      if (existing) return await openExisting(existing.id);
      const senderIdentityId = await chooseReplyIdentity({ conversationId, generation, request: { intent, message, quotedBody } });
      if (!senderIdentityId || !stillHere()) return;
      const seedResponse = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post({
        param,
        json: {
          origin: {
            kind: "compose",
            input: {
              senderIdentityId,
              to: [],
              cc: [],
              bcc: [],
              subject: intent === "forward" ? forwardSubject(props.subject) : replySubject(props.subject),
              body: quotedBody ?? "",
              conversationId,
              intent,
              sourceMessageId: message.id,
              includeSourceAttachments: intent === "forward" && message.attachments.length > 0,
            },
          },
        },
      });
      if (!seedResponse.ok) throw new Error(await readApiError(seedResponse, t().createDraftFailed));
      const seed = await seedResponse.json();
      const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].materialize.$post({
        param,
        json: { idempotencyKey: seed.id, origin: seed.origin, draft: seed.content },
      });
      if (!response.ok) {
        const failure = await readApiFailure(response, t().createDraftFailed);
        if (response.status === 409 && failure.draftId) return await openExisting(failure.draftId);
        throw failure;
      }
      const draft = await response.json();
      if (draft.creationOutcome === "existing" || draft.creationOutcome === "suggestion_skipped") return await openExisting(draft.id);
      if (!stillHere()) {
        // The person moved on while the empty draft was created; it goes again instead of waiting in that conversation.
        if (draft.creationOutcome === "created")
          void apiClient.mailboxes[":mailboxId"].drafts[":draftId"].discard
            .$post({ param: { ...param, draftId: draft.id }, json: { expectedRevision: draft.revision } })
            .catch(() => undefined);
        return;
      }
      await openInlineDraft({ conversationId, draftId: draft.id, initialDraft: draft, fresh: draft.creationOutcome === "created" });
    } catch (error) {
      if (stillHere())
        void prompts.error(error instanceof Error ? error.message : t().createDraftFailed, { title: t().startMessageFailed });
    } finally {
      setInlineStarting(false);
    }
  };

  const startComposer = (intent: DraftIntent, message: MailWorkspaceMessage, quotedBody?: string, target?: Window) => {
    const conversationId = props.selectedConversationId;
    if (!conversationId || composerBusy()) return void target?.close();
    // A window of its own keeps the compose page; everything else writes in the conversation.
    if (!target) return void startInlineDraft(intent, message, quotedBody);
    void conversationDrafts().mutate({
      generation: readerMailboxGeneration,
      conversationId,
      request: { intent, message, quotedBody, window: target },
    });
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
    conversationDrafts().abort();
    createdDraft().abort();
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
    closeDraftDialog?.(undefined);
    closeDraftDialog = null;
    cleanupPrint?.();
    if (readerScrollFrame !== null) cancelAnimationFrame(readerScrollFrame);
    readerScrollFrame = null;
    summarySave().abort();
    conversationDrafts().abort();
    createdDraft().abort();
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

  const canRespondToLatest = () => {
    const message = latestMessage();
    if (!message || !props.canWrite || !props.selectedConversationId) return false;
    return !message.delivery || messageDeliveryAllowsResponses(message.delivery.state);
  };

  const canReplyAllToLatest = () => {
    const message = latestMessage();
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
    const message = latestMessage();
    if (!message || !canRespondToLatest()) return void target?.close();
    startComposer(intent, message, intent === "forward" ? forwardMessageBody(message, props.dateConfig, locale()) : undefined, target);
  };
  /** Answers the latest message; a window of its own opens during the click, as browsers allow only then. */
  const respond = (intent: MailRespondIntent, options: { window: boolean }) => {
    if (!options.window) return respondToLatest(intent);
    const target = openMailReplyWindow();
    if (!target) return void prompts.error(t().allowReplyWindow);
    respondToLatest(intent, target);
  };

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

  // The pill's Reply names whom it writes to: Reply-To, or the original recipients of a message this mailbox sent.
  const latestReplyNames = () => {
    const message = latestMessage();
    const to = message ? deriveReplyAddressObjects(message, "reply", props.identities).to : [];
    return to.length ? to.map((item) => item.name || item.address).join(", ") : t().unknownSender;
  };
  const keepMenuItem = (): DropdownAction[] => {
    const keep = keepAction();
    if (!keep) return [];
    return [
      keep.disabled && keep.description
        ? { label: keep.label, icon: keep.icon, description: keep.description, disabled: true }
        : { label: keep.label, icon: keep.icon, disabled: keep.disabled, action: keep.action },
    ];
  };

  /**
   * The reply pill's actions after Reply, in the order of `REPLY_PILL_ACTIONS`; each runs an existing reader action.
   * Every action shows its label while the row has room; then labels give way to icons, and only then do actions move
   * into More. Reply always stays.
   */
  const pillActions = createMemo(() => {
    type PillAction = {
      id: ReplyPillActionId;
      label: string;
      icon: string;
      priority: number;
      text?: boolean;
      disabled?: boolean;
      run: () => void;
    };
    const actions: PillAction[] = [];
    for (const id of REPLY_PILL_ACTIONS) {
      if (id === "reply_all" && canRespondToLatest() && canReplyAllToLatest())
        actions.push({
          id,
          label: t().replyAll,
          icon: "ti ti-arrow-back-up-double",
          priority: 2,
          text: true,
          disabled: composerBusy(),
          run: () => respondToLatest("reply_all"),
        });
      if (id === "forward" && canRespondToLatest())
        actions.push({
          id,
          label: t().forward,
          icon: "ti ti-arrow-forward-up",
          priority: 2,
          text: true,
          disabled: composerBusy(),
          run: () => respondToLatest("forward"),
        });
    }
    return actions;
  });

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
              <div
                class="mail-reading-column"
                data-mail-reading-column
                data-draft-fullscreen={visibleInlineDraft() && props.draftFullscreen ? "" : undefined}
              >
                <Show when={draftOutOfView()}>
                  <div class="mail-draft-fullscreen-bar" data-mail-draft-bar role="group" aria-label={t().conversationActions}>
                    <span class="mail-draft-fullscreen-bar-title">
                      <i class="ti ti-arrow-back-up" aria-hidden="true" />
                      {t().replyTo({ name: latestReplyNames() })}
                    </span>
                    <Button type="button" size="sm" variant="ghost" onClick={backToText}>
                      <i class="ti ti-arrow-up" aria-hidden="true" />
                      {t().backToDraftText}
                    </Button>
                    <Button type="button" size="sm" onClick={() => inlineDraftControls?.send()}>
                      <i class="ti ti-send" aria-hidden="true" />
                      {t().sendDraft}
                    </Button>
                    <Tooltip.Anchor content={t().leaveFullscreen}>
                      <IconButton type="button" size="sm" label={t().leaveFullscreen} onClick={() => props.onToggleDraftFullscreen?.()}>
                        <i class="ti ti-arrows-minimize" aria-hidden="true" />
                      </IconButton>
                    </Tooltip.Anchor>
                  </div>
                </Show>
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
                                  openDraft: (draftId) =>
                                    props.selectedConversationId &&
                                    void openInlineDraft({ conversationId: props.selectedConversationId, draftId, fresh: false }),
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
                {/* The reply affordance follows the newest message at the end of the conversation (Mail v5): one floating
                    pill at the bottom of the reader. It runs the reader's existing actions and changes no compose logic.
                    The pill grows into the draft: an open draft stands in its place, below the newest message. */}
                <Show when={visibleInlineDraft()} keyed>
                  {(open) => (
                    <div class="mail-inline-draft-frame" data-mail-inline-draft-frame>
                      <MailInlineDraft
                        mailboxId={props.mailboxId}
                        draftId={open.draftId}
                        initialDraft={open.initialDraft}
                        currentUserId={props.currentUserId ?? ""}
                        currentUserEmail={props.currentUserEmail ?? null}
                        identities={props.identities}
                        dateConfig={props.dateConfig}
                        canAdmin={props.canAdmin}
                        mailboxRecipientSuggestions={props.mailboxWide}
                        calendarIntegrationAvailable={props.calendarIntegrationAvailable}
                        liveDictation={props.liveDictation ?? false}
                        returnHref={props.requestUrl}
                        host={{
                          fresh: open.fresh,
                          fullscreen: () => props.draftFullscreen ?? false,
                          toggleFullscreen: () => props.onToggleDraftFullscreen?.(),
                          register: (controls) => {
                            inlineDraftControls = controls;
                          },
                          messageLabel: (messageId) => {
                            const message = props.messages.find((candidate) => candidate.id === messageId);
                            if (!message) return null;
                            const sender = message.from[0];
                            const name = sender?.name || sender?.address || "";
                            return `${name}, ${dates.formatDateTimeRelative(message.internalDate, props.dateConfig)}`;
                          },
                          leave: (outcome) => {
                            closeInlineDraft(open.draftId);
                            // The sent message, the returned draft, or the removed one shows from the server's state.
                            if (outcome !== "closed") void props.onReconcileAfterWrite().catch(() => undefined);
                          },
                          openDraft: (draftId) => {
                            closeInlineDraft(open.draftId);
                            void openInlineDraft({ conversationId: open.conversationId, draftId, fresh: false });
                          },
                        }}
                      />
                    </div>
                  )}
                </Show>
                <Show when={otherDrafts().length > 0}>
                  <ul class="mail-reader-drafts" aria-label={t().conversationDraftsLabel}>
                    <For each={otherDrafts()}>
                      {(draft) => (
                        <li>
                          <button
                            type="button"
                            class="mail-reader-draft-row"
                            data-mail-draft-row={draft.id}
                            disabled={inlineStarting()}
                            onClick={() =>
                              props.selectedConversationId &&
                              void openInlineDraft({ conversationId: props.selectedConversationId, draftId: draft.id, fresh: false })
                            }
                          >
                            <i class={`ti ${draftIntentIcon(draft.intent)}`} aria-hidden="true" />
                            <span class="mail-reader-draft-row-intent">
                              {draft.intent === "reply"
                                ? t().draftRowReply
                                : draft.intent === "reply_all"
                                  ? t().draftRowReplyAll
                                  : draft.intent === "forward"
                                    ? t().draftRowForward
                                    : t().draftRowMessage}
                            </span>
                            <span class="mail-reader-draft-row-meta">
                              {draft.createdByDisplayName} · {dates.formatDateTimeRelative(draft.updatedAt, props.dateConfig)}
                            </span>
                            <span class="mail-reader-draft-row-preview">{draft.bodyPreview || draft.subject || t().noContent}</span>
                            <span class="mail-reader-draft-row-open">{t().openDraft}</span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={!visibleInlineDraft() && (canRespondToLatest() || pillActions().length > 0)}>
                  <div class="mail-reader-reply-pill" data-mail-reply-pill>
                    {/* As the reader narrows, labels give way to icons (Reply keeps its word), then actions move into More. */}
                    <Toolbar label={t().conversationActions} variant="floating" edge="bottom">
                      <Show when={canRespondToLatest()}>
                        {/* A saved draft shows as a dot on Reply, and Reply's name says so. */}
                        <Button
                          type="button"
                          variant="ghost"
                          class="mail-reader-pill-reply"
                          data-mail-toolbar-action="reply"
                          aria-label={props.conversationDrafts.length > 0 ? t().replyDraftAvailable : t().reply}
                          title={t().replyTo({ name: latestReplyNames() })}
                          disabled={composerBusy()}
                          onClick={() => respondToLatest("reply")}
                        >
                          <i class="ti ti-arrow-back-up" aria-hidden="true" />
                          {t().reply}
                          <Show when={props.conversationDrafts.length > 0}>
                            <span class="mail-reader-draft-dot" data-mail-draft-indicator aria-hidden="true" />
                          </Show>
                        </Button>
                      </Show>
                      <For each={pillActions()}>
                        {(action) => (
                          <Toolbar.Action
                            label={action.label}
                            icon={action.icon}
                            text={action.text}
                            priority={action.priority}
                            disabled={action.disabled}
                            onClick={action.run}
                          />
                        )}
                      </For>
                    </Toolbar>
                  </div>
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
