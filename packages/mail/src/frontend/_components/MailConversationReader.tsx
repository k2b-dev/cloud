import { documentNavigate, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  Dropdown,
  type DropdownItem,
  IconButton,
  IconButtonLink,
  NoticeCard,
  Placeholder,
  prompts,
  ScrollArea,
  Select,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import type { CloudTheme } from "@k2b/cloud/shared";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  ConversationDraftSummary,
  DeriveDraftFromMessageInput,
  DraftDerivationKind,
  DraftIntent,
  MailDraftSeed,
  SenderIdentity,
} from "../../contracts";
import type { MailActivityEvent } from "../../service/collaboration";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import type { MessageDetail } from "../../service/messages";
import { readApiError } from "./api-response";
import MailConversationSummaryCard from "./MailConversationSummaryCard";
import { openMailConversationToolbarDialog } from "./MailConversationToolbarDialog";
import MailMessageCard from "./MailMessageCard";
import { getMailAction, type MailActionId } from "./mail-actions";
import {
  deriveReplyIdentityId,
  deriveReplyRecipients,
  forwardMessageBody,
  forwardSubject,
  quoteReplyBody,
  replySubject,
} from "./mail-compose-derivation";
import { mailDraftHref, mailDraftSeedHref } from "./mail-compose-route";
import { initialConversationMessageId, isNearConversationStart, newestFirstMessages } from "./mail-conversation-history";
import { buildMailConversationTimeline } from "./mail-conversation-timeline";
import { getMailConversationToolbarSections, type MailConversationToolbarActionId } from "./mail-conversation-toolbar";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { storeMailDraftSeed } from "./mail-draft-seed-store";
import { messageDeliveryAllowsResponses } from "./mail-message-presentation";
import { buildMailListHref } from "./mail-navigation";
import type { MailReadingFormat } from "./mail-user-preferences";

type MailConversationComposerRequest = {
  intent: DraftIntent;
  message: MessageDetail;
  quotedBody?: string;
};

type DraftLookup = {
  conversationId: string;
  request: MailConversationComposerRequest;
};

type DirectToolbarAction = {
  id: MailConversationToolbarActionId;
  label: string;
  icon: string;
  disabled?: boolean;
  action: () => void;
};

export default function MailConversationReader(props: {
  mailboxId: string;
  requestUrl: string;
  canWrite: boolean;
  canAdmin: boolean;
  identities: SenderIdentity[];
  selectionKey: string | null;
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  unread: boolean;
  flagged: boolean;
  inJunk: boolean;
  reference: string | null;
  subject: string;
  messages: MessageDetail[];
  activity: MailActivityEvent[];
  conversationSummary: ConversationContentSummary | null;
  conversationDrafts: ConversationDraftSummary[];
  totalMessageCount: number;
  error: string | null;
  dateConfig: DateContext;
  readingFormat: MailReadingFormat;
  theme: CloudTheme;
  calendarIntegrationAvailable: boolean;
  listCollapsed: boolean;
  detailsOpen: boolean;
  toolbarActions: readonly MailConversationToolbarActionId[];
  onRestoreList: () => void;
  onToggleDetails: () => void;
  onToolbarActionsChange: (actions: MailConversationToolbarActionId[]) => void;
  actionPending: boolean;
  onAction: (actionId: MailActionId, options?: { silent?: boolean }) => void | Promise<void>;
  onOpenHref: (href: string, replace?: boolean) => void | Promise<void>;
  onManageTags: () => void | Promise<void>;
  onMergeConversation: () => void | Promise<void>;
  onReassignMessage: (messageId: string) => void | Promise<void>;
  onSplitMessage: (messageId: string) => void | Promise<void>;
  onSummarySaved: (conversationId: string, summary: ConversationContentSummary) => Promise<void>;
  onReconcile: () => Promise<void>;
  onReconcileAfterWrite: () => Promise<void>;
  onClose: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
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
  const orderedMessages = createMemo(() => newestFirstMessages(props.messages));
  const timeline = createMemo(() => buildMailConversationTimeline(props.messages, props.activity, locale()));
  const latestMessage = createMemo(() => orderedMessages()[0] ?? null);
  const [expandedMessages, setExpandedMessages] = createSignal(new Set(initialMessageId ? [initialMessageId] : []));
  const [messageSelections, setMessageSelections] = createSignal<Record<string, string>>({});
  const [pendingNewMessages, setPendingNewMessages] = createSignal(0);
  const summarySave = mutations.create<
    { created: boolean; refreshError: Error | null },
    { conversationId: string; expectedSummaryRevision: number; summary: string; created: boolean }
  >({
    mutation: async ({ conversationId, expectedSummaryRevision, summary, created }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].summary.$put(
        {
          param: { mailboxId: props.mailboxId, conversationId },
          json: { expectedSummaryRevision, summary },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().updateSummaryFailed));
      const updated = await response.json();
      let refreshError: Error | null = null;
      try {
        await props.onSummarySaved(conversationId, updated);
      } catch (error) {
        refreshError = error instanceof Error ? error : new Error(String(error));
      }
      return { created, refreshError };
    },
    onSuccess: ({ created, refreshError }) => {
      toast.success(created ? t().summaryCreated : t().summaryUpdated);
      if (refreshError) void prompts.error(refreshError.message, { title: t().summaryRefreshFailed });
    },
    onError: (error) => prompts.error(error.message),
  });
  const summarySaving = summarySave.loading;
  const closeHref = () => buildMailListHref(new URL(props.requestUrl));
  let closeDraftDialog: ((value: ConversationDraftSummary | null | undefined) => void) | null = null;
  let cleanupPrint: (() => void) | null = null;
  let historyScroller: HTMLDivElement | undefined;
  let readerScrollFrame: number | null = null;
  let followingNewest = true;
  let disposed = false;
  const scrollPositions = new Map<string, number>();
  const expandedBySelection = new Map<string, Set<string>>();

  const rememberReaderState = (selectionKey: string, scrollTop: number, expanded: Set<string>) => {
    scrollPositions.delete(selectionKey);
    scrollPositions.set(selectionKey, scrollTop);
    expandedBySelection.delete(selectionKey);
    expandedBySelection.set(selectionKey, new Set(expanded));
    if (scrollPositions.size <= 50) return;
    const oldest = scrollPositions.keys().next().value;
    if (!oldest) return;
    scrollPositions.delete(oldest);
    expandedBySelection.delete(oldest);
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
      followingNewest = isNearConversationStart(historyScroller);
    });
  };

  const handleReaderScroll = () => {
    if (!historyScroller) return;
    followingNewest = isNearConversationStart(historyScroller);
    if (followingNewest && pendingNewMessages() > 0) setPendingNewMessages(0);
  };

  const jumpToNewest = () => {
    const newest = props.messages.at(-1);
    if (!newest) return;
    setExpandedMessages((current) => new Set(current).add(newest.id));
    setPendingNewMessages(0);
    followingNewest = true;
    scheduleReaderScroll({ selectionKey: props.selectionKey, messageId: newest.id, behavior: "smooth" });
  };

  const editConversationSummary = async () => {
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
    if (!values || conversationId !== props.selectedConversationId) return;
    await summarySave.mutate({
      conversationId,
      expectedSummaryRevision: current.summaryRevision,
      summary: String(values.summary ?? ""),
      created: !current.summary,
    });
  };

  const toggleMessage = (messageId: string) =>
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });

  const isCurrentLookup = (lookup: DraftLookup) => !disposed && props.selectedConversationId === lookup.conversationId;

  const openConversationDraft = (lookup: DraftLookup, draftId: string) => {
    if (!isCurrentLookup(lookup)) return;
    documentNavigate(mailDraftHref(props.mailboxId, draftId, props.requestUrl));
  };

  const openDraftSeed = (seed: MailDraftSeed) => {
    try {
      storeMailDraftSeed(localStorage, seed);
    } catch {
      void prompts.error(t().localDraftFailed, {
        title: t().startMessageFailed,
      });
      return;
    }
    documentNavigate(mailDraftSeedHref(props.mailboxId, seed.id, props.requestUrl));
  };

  const chooseConversationDraft = async (lookup: DraftLookup, existingDrafts: ConversationDraftSummary[]) => {
    if (!isCurrentLookup(lookup)) return;
    if (existingDrafts.length === 0) return void createConversationDraft(lookup);
    const selected = await prompts.dialog<ConversationDraftSummary | null>(
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
              <Button size="sm" type="button" onClick={() => close(null)}>
                <i class="ti ti-plus" aria-hidden="true" />
                {t().newIntent({ intent: intentLabel(lookup.request.intent) })}
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
    if (selected === undefined || !isCurrentLookup(lookup)) return;
    if (selected) return void openConversationDraft(lookup, selected.id);
    void createConversationDraft(lookup);
  };

  const conversationDrafts = mutations.create<ConversationDraftSummary[], DraftLookup, DraftLookup>({
    onBefore: (lookup) => lookup,
    mutation: async (lookup, { abortSignal }) => {
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
    onError: (error) => prompts.error(error.message),
  });

  const createdDraft = mutations.create<MailDraftSeed, { lookup: DraftLookup; senderIdentityId: string }, DraftLookup>({
    onBefore: ({ lookup }) => lookup,
    mutation: async ({ lookup, senderIdentityId }, { abortSignal }) => {
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
      if (lookup && isCurrentLookup(lookup)) openDraftSeed(seed);
    },
    onError: (error) => prompts.error(error.message, { title: t().startMessageFailed }),
  });

  const chooseReplyIdentity = async (lookup: DraftLookup): Promise<string | null> => {
    const identities = props.identities.filter((identity) => identity.status === "verified");
    const derived = deriveReplyIdentityId(lookup.request.message, identities);
    if (derived) return derived;
    if (identities.length === 0) {
      await prompts.error(t().verifiedSenderRequired);
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
    if (!isCurrentLookup(lookup) || createdDraft.loading()) return;
    const senderIdentityId = await chooseReplyIdentity(lookup);
    if (!senderIdentityId || !isCurrentLookup(lookup) || createdDraft.loading()) return;
    createdDraft.mutate({ lookup, senderIdentityId });
  };

  const derivedDraft = mutations.create<
    MailDraftSeed,
    {
      message: MessageDetail;
      input: Omit<DeriveDraftFromMessageInput, "idempotencyKey">;
    },
    { message: MessageDetail }
  >({
    onBefore: ({ message }) => ({ message }),
    mutation: async ({ message, input }, { abortSignal }) => {
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
      if (context && props.messages.some((message) => message.id === context.message.id)) {
        openDraftSeed(seed);
      }
    },
    onError: (error) => prompts.error(error.message),
  });
  const composerBusy = () => conversationDrafts.loading() || createdDraft.loading() || derivedDraft.loading();

  const startComposer = (intent: DraftIntent, message: MessageDetail, quotedBody?: string) => {
    const conversationId = props.selectedConversationId;
    if (!conversationId || composerBusy()) return;
    void conversationDrafts.mutate({
      conversationId,
      request: { intent, message, quotedBody },
    });
  };

  const deriveMessage = async (kind: DraftDerivationKind, message: MessageDetail) => {
    if (composerBusy() || derivedDraft.loading()) return;
    const selectionKey = props.selectionKey;
    const identities = props.identities.filter((identity) => identity.status === "verified");
    const defaultIdentity = identities.find((identity) => identity.isDefault) ?? identities[0];
    if (!defaultIdentity) return prompts.error(t().verifiedSenderReuseRequired);
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
    if (choice && !disposed && selectionKey === props.selectionKey && props.messages.some((current) => current.id === message.id)) {
      derivedDraft.mutate({ message, input: choice });
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
    conversationDrafts.abort();
    createdDraft.abort();
    const savedExpanded = nextSelection ? expandedBySelection.get(nextSelection) : null;
    const targetMessageId = selectedHistoryMessageId();
    setExpandedMessages(
      savedExpanded
        ? new Set([...savedExpanded].filter((messageId) => nextMessageIds.has(messageId)))
        : new Set(targetMessageId ? [targetMessageId] : []),
    );
    setMessageSelections({});
    setPendingNewMessages(0);
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

  createEffect(() => {
    const nextSelection = props.selectionKey;
    const nextMessageIds = new Set(props.messages.map((message) => message.id));
    if (nextSelection !== currentSelection) {
      restoreHistorySelection(nextSelection, nextMessageIds);
      return;
    }
    applyAddedMessages(nextSelection, nextMessageIds);
  });

  onMount(() => {
    scheduleReaderScroll({ selectionKey: props.selectionKey, messageId: initialMessageId });
  });

  onCleanup(() => {
    disposed = true;
    closeDraftDialog?.(undefined);
    closeDraftDialog = null;
    cleanupPrint?.();
    if (readerScrollFrame !== null) cancelAnimationFrame(readerScrollFrame);
    summarySave.abort();
    conversationDrafts.abort();
    createdDraft.abort();
    derivedDraft.abort();
  });

  const startQuoteReply = (message: MessageDetail, body: HTMLElement) => {
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
      root.classList.remove("mail-printing-conversation");
      if (props.selectionKey === printSelection) setExpandedMessages(expandedBeforePrint);
      window.removeEventListener("afterprint", cleanup);
      if (timeout) clearTimeout(timeout);
      if (frame !== null) cancelAnimationFrame(frame);
      if (cleanupPrint === cleanup) cleanupPrint = null;
    };
    cleanupPrint = cleanup;
    setExpandedMessages(new Set(props.messages.map((message) => message.id)));
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

  const canSplitConversation = () => props.canWrite && (props.totalMessageCount > 1 || props.messages.length > 1);

  const localizedActionLabel = (actionId: MailActionId): string =>
    actionId === "archive"
      ? t().archive
      : actionId === "move"
        ? t().moveToFolder
        : actionId === "trash"
          ? t().trash
          : actionId === "junk"
            ? t().junk
            : actionId === "not_spam"
              ? t().notSpam
              : actionId === "mark_read"
                ? t().markRead
                : actionId === "mark_unread"
                  ? t().markUnread
                  : actionId === "flag"
                    ? t().flag
                    : t().unflag;

  const respondToLatest = (intent: Extract<DraftIntent, "reply" | "reply_all" | "forward">) => {
    const message = latestMessage();
    if (!message || !canRespondToLatest()) return;
    startComposer(intent, message, intent === "forward" ? forwardMessageBody(message, props.dateConfig, locale()) : undefined);
  };

  const directToolbarAction = (id: MailConversationToolbarActionId): DirectToolbarAction | null => {
    if (id === "print") {
      return { id, label: t().printConversation, icon: "ti ti-printer", action: printConversation };
    }
    if (id === "reply" || id === "reply_all" || id === "forward") {
      if (!canRespondToLatest()) return null;
      if (id === "reply_all" && !canReplyAllToLatest()) return null;
      const label =
        id === "reply"
          ? props.conversationDrafts.length > 0
            ? t().replyDraftAvailable
            : t().reply
          : id === "reply_all"
            ? t().replyAll
            : t().forward;
      const icon = id === "reply" ? "ti ti-arrow-back-up" : id === "reply_all" ? "ti ti-arrow-back-up-double" : "ti ti-arrow-forward-up";
      return {
        id,
        label,
        icon,
        disabled: composerBusy(),
        action: () => respondToLatest(id),
      };
    }
    if (id === "split") {
      const message = latestMessage();
      if (!message || !canSplitConversation()) return null;
      return {
        id,
        label: t().splitLatest,
        icon: "ti ti-arrows-split-2",
        disabled: props.actionPending,
        action: () => void props.onSplitMessage(message.id),
      };
    }
    if (!props.canWrite) return null;
    if (id === "tags") {
      return {
        id,
        label: t().tags,
        icon: "ti ti-tags",
        disabled: props.actionPending,
        action: () => void props.onManageTags(),
      };
    }
    if (id === "merge") {
      return {
        id,
        label: t().mergeWithConversation,
        icon: "ti ti-git-merge",
        disabled: props.actionPending,
        action: () => void props.onMergeConversation(),
      };
    }
    const actionId: MailActionId =
      id === "spam"
        ? props.inJunk
          ? "not_spam"
          : "junk"
        : id === "read"
          ? props.unread
            ? "mark_read"
            : "mark_unread"
          : id === "flag"
            ? props.flagged
              ? "unflag"
              : "flag"
            : id;
    const action = getMailAction(actionId);
    return {
      id,
      label: localizedActionLabel(actionId),
      icon: action.icon,
      disabled: props.actionPending,
      action: () => void props.onAction(actionId),
    };
  };

  const directToolbarSections = createMemo(() =>
    getMailConversationToolbarSections(locale())
      .map((section) => ({
        id: section.id,
        actions: section.options.flatMap((option) => {
          if (!props.toolbarActions.includes(option.id)) return [];
          const action = directToolbarAction(option.id);
          return action ? [action] : [];
        }),
      }))
      .filter((section) => section.actions.length > 0),
  );

  const customizeToolbar = async () => {
    const next = await openMailConversationToolbarDialog(props.toolbarActions);
    if (next) props.onToolbarActionsChange(next);
  };

  const overflowActions = (): DropdownItem[] => {
    const actions: DropdownItem[] = [];
    if (canRespondToLatest()) {
      actions.push({
        sectionLabel: t().respond,
        items: [
          {
            label: t().reply,
            icon: "ti ti-arrow-back-up",
            action: () => respondToLatest("reply"),
          },
          ...(canReplyAllToLatest()
            ? [
                {
                  label: t().replyAll,
                  icon: "ti ti-arrow-back-up-double",
                  action: () => respondToLatest("reply_all"),
                },
              ]
            : []),
          {
            label: t().forward,
            icon: "ti ti-arrow-forward-up",
            action: () => respondToLatest("forward"),
          },
        ],
      });
    }
    if (props.canWrite) {
      actions.push({
        sectionLabel: t().organize,
        items: [
          {
            label: localizedActionLabel("archive"),
            icon: getMailAction("archive").icon,
            action: () => props.onAction("archive"),
          },
          {
            label: localizedActionLabel(props.inJunk ? "not_spam" : "junk"),
            icon: getMailAction(props.inJunk ? "not_spam" : "junk").icon,
            action: () => props.onAction(props.inJunk ? "not_spam" : "junk"),
          },
          {
            label: localizedActionLabel("trash"),
            icon: getMailAction("trash").icon,
            action: () => props.onAction("trash"),
            variant: "danger",
          },
          {
            label: localizedActionLabel("move"),
            icon: getMailAction("move").icon,
            action: () => props.onAction("move"),
          },
        ],
      });
      actions.push({
        sectionLabel: t().mark,
        items: [
          {
            label: localizedActionLabel(props.unread ? "mark_read" : "mark_unread"),
            icon: getMailAction(props.unread ? "mark_read" : "mark_unread").icon,
            action: () => props.onAction(props.unread ? "mark_read" : "mark_unread"),
          },
          {
            label: localizedActionLabel(props.flagged ? "unflag" : "flag"),
            icon: getMailAction(props.flagged ? "unflag" : "flag").icon,
            action: () => props.onAction(props.flagged ? "unflag" : "flag"),
          },
          {
            label: t().tags,
            icon: "ti ti-tags",
            action: props.onManageTags,
          },
        ],
      });
      actions.push({
        sectionLabel: t().conversation,
        items: [
          {
            label: props.conversationSummary?.summary ? t().editSummary : t().createSummary,
            icon: "ti ti-notes",
            disabled: summarySaving() || !props.conversationSummary,
            action: () => void editConversationSummary(),
          },
          {
            label: t().mergeWithConversation,
            icon: "ti ti-git-merge",
            action: props.onMergeConversation,
          },
          ...(canSplitConversation() && latestMessage()
            ? [
                {
                  label: t().splitLatest,
                  icon: "ti ti-arrows-split-2",
                  action: () => {
                    const message = latestMessage();
                    if (message) void props.onSplitMessage(message.id);
                  },
                },
              ]
            : []),
        ],
      });
    }
    actions.push({
      sectionLabel: t().other,
      items: [
        {
          label: t().printConversation,
          icon: "ti ti-printer",
          action: printConversation,
        },
        {
          label: t().customizeToolbar,
          icon: "ti ti-adjustments-horizontal",
          action: () => void customizeToolbar(),
        },
      ],
    });
    return actions;
  };

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--ui-surface-raised)]" data-mail-print-root>
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
        <NoticeCard tone="warning" icon={false} class="mx-3 mt-3" role="status">
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
        <header class="flex shrink-0 flex-col gap-2 px-4 py-3">
          <div class="flex min-w-0 items-start gap-2">
            <IconButtonLink
              href={closeHref()}
              class="lg:hidden"
              label={t().backToList}
              navigation="enhanced"
              onNavigate={props.onClose}
              scroll="preserve"
            >
              <i class="ti ti-arrow-left" aria-hidden="true" />
            </IconButtonLink>
            <Show when={props.listCollapsed}>
              <Tooltip.Anchor content={t().showList}>
                <IconButton type="button" class="hidden lg:inline-flex" label={t().showList} onClick={props.onRestoreList}>
                  <i class="ti ti-layout-sidebar-left-expand" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            </Show>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <h1 class="truncate text-lg font-semibold text-primary" data-mail-reader-heading tabIndex={-1}>
                  {props.subject || t().noSubject}
                </h1>
                <Show when={props.flagged}>
                  <Tooltip.Anchor content={t().flaggedConversation}>
                    <span
                      class="flex h-7 w-7 shrink-0 items-center justify-center text-orange-600 dark:text-orange-400"
                      role="img"
                      aria-label={t().flaggedConversation}
                    >
                      <i class={getMailAction("flag").icon} aria-hidden="true" />
                    </span>
                  </Tooltip.Anchor>
                </Show>
                <Show when={props.reference}>
                  <button
                    type="button"
                    class="chip shrink-0 font-mono text-xs"
                    title={t().copyReference}
                    onClick={() => {
                      const reference = props.reference;
                      if (!reference) return;
                      void navigator.clipboard.writeText(reference).then(
                        () => toast.success(t().referenceCopied),
                        () => toast.error(t().referenceCopyFailed),
                      );
                    }}
                  >
                    <i class="ti ti-hash" aria-hidden="true" />
                    {props.reference}
                  </button>
                </Show>
              </div>
              <p class="mt-0.5 text-xs text-dimmed">{t().messageCount({ count: props.messages.length })}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <div class="hidden max-w-[min(40vw,28rem)] items-center gap-2 overflow-x-auto sm:flex">
                <For each={directToolbarSections()}>
                  {(section) => (
                    <div class="flex shrink-0 items-center gap-1" data-mail-toolbar-section={section.id}>
                      <For each={section.actions}>
                        {(action) => (
                          <>
                            <Show when={action.id === "reply" && props.conversationDrafts.length > 0}>
                              <span class="hidden whitespace-nowrap text-xs text-dimmed sm:inline" data-mail-draft-label>
                                {t().draftAvailable}
                              </span>
                            </Show>
                            <Tooltip.Anchor content={action.label}>
                              <IconButton
                                type="button"
                                class="relative shrink-0"
                                label={action.label}
                                data-mail-toolbar-action={action.id}
                                disabled={action.disabled}
                                onClick={action.action}
                              >
                                <i class={action.icon} aria-hidden="true" />
                                <Show when={action.id === "reply" && props.conversationDrafts.length > 0}>
                                  <span
                                    class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ui-accent)] sm:hidden"
                                    data-mail-draft-indicator
                                    aria-hidden="true"
                                  />
                                </Show>
                              </IconButton>
                            </Tooltip.Anchor>
                          </>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
              <Dropdown.Root position="bottom-left" width="14rem" items={overflowActions()}>
                <Dropdown.Trigger iconOnly type="button" variant="ghost" label={t().moreConversationActions}>
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
              <Tooltip.Anchor content={t().conversationDetails}>
                <IconButton
                  type="button"
                  classList={{ "bg-[var(--ui-selected)]": props.detailsOpen }}
                  label={t().toggleDetails}
                  aria-pressed={props.detailsOpen}
                  data-mail-details-trigger
                  onClick={props.onToggleDetails}
                >
                  <i class="ti ti-layout-sidebar-right" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            </div>
          </div>
        </header>

        <div class="relative min-h-0 flex-1 overflow-hidden">
          <ScrollArea
            ref={historyScroller}
            class="absolute inset-0 px-3 py-2 sm:px-5"
            scrollPreserveKey={`mail-reader-${props.selectionKey}`}
            onScroll={handleReaderScroll}
          >
            <Show when={props.conversationSummary?.summary}>
              {(summary) => (
                <MailConversationSummaryCard
                  summary={summary()}
                  canEdit={props.canWrite}
                  editDisabled={summarySaving()}
                  onEdit={() => void editConversationSummary()}
                />
              )}
            </Show>
            <div class="mx-auto flex w-full max-w-4xl flex-col gap-2" data-mail-conversation-messages>
              <For each={timeline()}>
                {(item) =>
                  item.kind === "activity" ? (
                    <div class="flex min-w-0 items-center gap-2 px-2 py-0.5 text-xs leading-5 text-dimmed" data-mail-conversation-activity>
                      <i
                        class={`ti ${item.activity.icon} w-4 shrink-0 text-center ${item.activity.outcome === "failed" ? "text-red-500" : "text-dimmed"}`}
                        aria-hidden="true"
                      />
                      <span class="min-w-0 flex-1">
                        <span class="font-medium text-secondary">{item.activity.actorLabel}</span> {item.activity.label}
                        <Show when={item.activity.count > 1}> ({item.activity.count})</Show>
                      </span>
                      <time
                        class="shrink-0 text-dimmed"
                        dateTime={item.activity.createdAt}
                        title={dates.formatDateTime(item.activity.createdAt, props.dateConfig)}
                      >
                        {dates.formatDateTimeRelative(item.activity.createdAt, props.dateConfig)}
                      </time>
                    </div>
                  ) : (
                    <MailMessageCard
                      message={item.message}
                      expanded={expandedMessages().has(item.message.id)}
                      isLatest={props.messages.at(-1)?.id === item.message.id}
                      selectionAvailable={Boolean(messageSelections()[item.message.id])}
                      context={{
                        mailboxId: props.mailboxId,
                        requestUrl: props.requestUrl,
                        canWrite: props.canWrite,
                        canAdmin: props.canAdmin,
                        selectionKey: props.selectionKey,
                        selectedConversationId: props.selectedConversationId,
                        totalMessageCount: props.totalMessageCount,
                        identities: props.identities,
                        dateConfig: props.dateConfig,
                        readingFormat: props.readingFormat,
                        theme: props.theme,
                        calendarIntegrationAvailable: props.calendarIntegrationAvailable,
                        composerBusy: composerBusy(),
                      }}
                      actions={{
                        toggle: toggleMessage,
                        selectionChange: (messageId, value) =>
                          setMessageSelections((current) => {
                            if (value)
                              return current[messageId] === value && Object.keys(current).length === 1 ? current : { [messageId]: value };
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
                        reassign: props.onReassignMessage,
                        split: props.onSplitMessage,
                      }}
                    />
                  )
                }
              </For>
            </div>
          </ScrollArea>
          <Show when={pendingNewMessages()}>
            {(count) => (
              <Button
                size="sm"
                type="button"
                class="absolute left-1/2 top-3 z-10 -translate-x-1/2 shadow-[var(--ui-shadow-float)]"
                aria-live="polite"
                onClick={jumpToNewest}
              >
                {t().newMessages({ count: count() })}
                <i class="ti ti-arrow-up" aria-hidden="true" />
              </Button>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
