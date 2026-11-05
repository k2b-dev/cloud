import type {
  AiConversation,
  AiConversationTimelineEntry,
  AiOpenQuestion,
  AiOpenQuestions,
  AiStoredMessage,
  AiTurnSnapshot,
} from "@k2b/cloud/ai";
import { createAiChatController } from "@k2b/cloud/ai/solid";
import {
  AiChatActionsProvider,
  type AiComposerAttachment,
  type AiModelChooserState,
  aiChatAttachments,
  aiComposerAttachmentRecords,
  aiComposerFileAccept,
  aiComposerSendInput,
  aiModelBlocksSending,
  createAiChatTimeline,
  readAiComposerFiles,
} from "@k2b/cloud/ai/ui";
import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { AiModelRequest, AiPeopleModels } from "@k2b/cloud/shared";
import { type LinkNavigateEvent, listenPopState, navigate } from "@k2b/ssr/nav";
import {
  AppWorkspace,
  Button,
  Chat,
  type ChatSubmitInput,
  type ChatTimelineItem,
  IconButtonLink,
  MobileShell,
  Placeholder,
  Skeleton,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { assistantApi } from "../api/client";
import { AssistantWaitingStrip, createWaitingQuestionFocus } from "../frontend/AssistantWaitingStrip";
import { createAssistantLiveHub, followAssistantLive, matchesAssistantInvalidation } from "../frontend/assistant-live";
import { waitingQuestionsView } from "../frontend/waiting-questions";
import { pwaMessages } from "./messages";
import { createOnline } from "./online";
import { addressHref, newChatHref, type PwaAddress, pwaAddress, startHref } from "./paths";
import { ChatRows, SkeletonRows } from "./rows";

/** How many chats the start lists; the rest are one step away. */
const RECENT = 6;
/** The draft of the field on the start and of a new chat. */
const NEW_DRAFT = "new";

type Detail = {
  conversation: AiConversation;
  messages: AiStoredMessage[];
  hasMoreMessages: boolean;
  activeTurn: AiTurnSnapshot | null;
  timeline: AiConversationTimelineEntry[];
};

export type AssistantPwaProps = {
  userId: string;
  /** The part's name and icon from the app's presentation. */
  name: string;
  icon: string;
  status: AiPeopleModels & { enabled: boolean; visionModelConfigured: boolean; liveDictationAvailable?: boolean };
  /** Whether the person may set up AI; the link leads to the web's administration. */
  canConfigure: boolean;
  timeZone: string;
  renderedAt: string;
  initialLiveCursor: string;
  initialAddress: PwaAddress;
  /** `null`: the list could not be read. */
  initialSidebar: { conversations: AiConversation[]; questions: AiOpenQuestions } | null;
  initialTotal: number | null;
  /** The chat the address names; `null` with a chat address: it does not exist or belongs to someone else. */
  initialDetail: Detail | null;
};

type List = { conversations: AiConversation[]; questions: AiOpenQuestions };
/** A message that did not reach its chat stays in the timeline with "Send again" instead of in the field. */
type FailedSend = { id: string; conversationId: string; input: ChatSubmitInput };

/**
 * The Assistant in the Cloud app. The start lists recent chats and what waits for the person, with a field to ask
 * something new; a chat opens on its own address. Below 64rem one of the two fills the page, a chat on a phone as a
 * screen of its own; from 64rem the list stands beside the chat. Everything reads and writes through the same AI
 * routes as the web Assistant, so permissions and ownership are the same.
 */
export default function AssistantPwa(props: AssistantPwaProps) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;
  const online = createOnline();
  const [address, setAddress] = createSignal<PwaAddress>(props.initialAddress);
  const [missing, setMissing] = createSignal(props.initialAddress.level === "chat" && !props.initialDetail);
  const initialChatId = props.initialDetail && props.initialAddress.level === "chat" ? props.initialAddress.id : null;
  const chat = createAiChatController({
    baseUrl: "/api/ai",
    initialConversationId: initialChatId,
    initialDetail: props.initialDetail,
    initialTimeline: props.initialDetail?.timeline,
    trackViewedState: true,
  });
  const [openFailed, setOpenFailed] = createSignal(false);

  // ---- the list
  const [list, setList] = createSignal<List | null>(props.initialSidebar);
  const [listState, setListState] = createSignal<"ready" | "loading" | "failed">(props.initialSidebar ? "ready" : "failed");
  const [total, setTotal] = createSignal(props.initialTotal);
  let listRequest: AbortController | undefined;
  const reloadList = async (quiet: boolean) => {
    listRequest?.abort();
    const request = new AbortController();
    listRequest = request;
    if (!quiet) setListState("loading");
    try {
      const [snapshot, page] = await Promise.all([
        assistantApi.loadSidebar(request.signal),
        assistantApi.listConversationsPage({ page: 1, perPage: 1, signal: request.signal }).catch(() => null),
      ]);
      if (request.signal.aborted) return;
      setList({ conversations: snapshot.conversations, questions: snapshot.questions });
      if (page) setTotal(page.total);
      setListState("ready");
    } catch (error) {
      if (request.signal.aborted) return;
      // A refresh that fails keeps what the list showed; only a list without data shows the failure. The error still
      // reaches the caller, so a live update is tried again instead of being acknowledged.
      if (!quiet || !list()) setListState("failed");
      throw error;
    }
  };
  const retryList = () => void reloadList(false).catch(() => undefined);
  const recent = createMemo(() =>
    [...(list()?.conversations ?? [])].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)).slice(0, RECENT),
  );
  const questions = (): AiOpenQuestions => list()?.questions ?? { items: [], count: 0 };

  // ---- live updates, as on the web
  const liveHub = createAssistantLiveHub();
  onMount(() => {
    const unregisterList = liveHub.register({
      matches: matchesAssistantInvalidation(["conversation-list"]),
      invalidate: () => reloadList(true),
    });
    const unregisterChat = liveHub.register({
      matches: (invalidation) => {
        const id = chat.activeConversationId();
        return id !== null && matchesAssistantInvalidation(["conversation-detail"], { conversationId: id })(invalidation);
      },
      invalidate: async () => {
        await chat.refreshActiveConversation();
      },
    });
    const subscription = followAssistantLive(liveHub, { cursor: props.initialLiveCursor, failing: () => {}, stopped: () => {} });
    // Coming back to the foreground or online reads the list again; the stream of an open chat resumes itself.
    const refresh = () => {
      if (document.visibilityState === "visible") void reloadList(true).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    onCleanup(() => {
      unregisterList();
      unregisterChat();
      subscription.close();
      listRequest?.abort();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    });
  });

  // ---- navigation inside the part
  let root: HTMLDivElement | undefined;
  const level = () => (address().level === "start" ? "start" : "chat");
  // On a phone a chat is a screen of its own: the tab bar steps aside. The server renders the first state.
  createEffect(on(level, (current) => root && MobileShell.setScreen(root, current === "chat"), { defer: true }));

  const show = (next: PwaAddress) => {
    setAddress(next);
    setOpenFailed(false);
    setMissing(false);
    if (next.level === "chat") void openChat(next.id);
    else chat.setActiveConversationId(null);
  };
  const openChat = async (id: string) => {
    setOpenFailed(false);
    const result = await chat.openConversation(id);
    if (result === "failed" && chat.activeConversationId() === id) {
      // The chat's place says it could not load; the field keeps its text and its hint line stays free.
      chat.setError(null);
      setOpenFailed(true);
    }
  };
  onMount(() => onCleanup(listenPopState(({ url }) => show(pwaAddress(url.pathname) ?? { level: "start" }))));
  const go = (next: PwaAddress, event?: LinkNavigateEvent) => {
    const fromList = address().level === "start";
    show(next);
    const href = addressHref(next);
    const state = { assistantFromList: fromList };
    if (event) event.push(href, { scroll: "manual", state });
    else navigate(href, { scroll: "manual", state });
  };
  const back = (event: LinkNavigateEvent) => {
    const state: unknown = history.state;
    if (state && typeof state === "object" && "assistantFromList" in state && state.assistantFromList === true) {
      history.back();
      return;
    }
    show({ level: "start" });
    event.replaceWith(startHref, { scroll: "manual", state: null });
  };

  // ---- the field: one draft per chat and one for a new chat, kept on the device until it is sent
  const draftKey = () => {
    const current = address();
    return current.level === "chat" ? current.id : NEW_DRAFT;
  };
  const serverDraft = (id: string) =>
    chat.conversation()?.id === id
      ? (chat
          .conversation()
          ?.draft.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("") ?? "")
      : "";
  const [texts, setTexts] = createSignal<Record<string, string>>(
    props.initialDetail && initialChatId ? { [initialChatId]: serverDraft(initialChatId) } : {},
  );
  const [files, setFiles] = createSignal<Record<string, AiComposerAttachment[]>>({});
  const [notice, setNotice] = createSignal<string | null>(null);
  const text = () => texts()[draftKey()] ?? "";
  const setText = (value: string) => {
    const key = draftKey();
    setTexts((current) => ({ ...current, [key]: value }));
    pwaDrafts.write(props.userId, `assistant.composer:${key}`, value);
  };
  /** What this device kept for a field wins over the chat's saved draft, also when it is empty. */
  const restoreDraft = (key: string) => {
    const kept = pwaDrafts.read(props.userId, `assistant.composer:${key}`);
    if (kept !== undefined) setTexts((current) => ({ ...current, [key]: kept }));
    else if (texts()[key] === undefined && key !== NEW_DRAFT) setTexts((current) => ({ ...current, [key]: serverDraft(key) }));
  };
  // Restored after mounting, so the server and the first frame show the same field.
  onMount(() => restoreDraft(draftKey()));
  createEffect(on(draftKey, (key) => restoreDraft(key), { defer: true }));
  const attachments = () => files()[draftKey()] ?? [];
  const clearDraft = (key: string) => {
    setTexts((current) => ({ ...current, [key]: "" }));
    setFiles((current) => ({ ...current, [key]: [] }));
    pwaDrafts.remove(props.userId, `assistant.composer:${key}`);
  };

  const canUseComposer = () => props.status.enabled && props.status.options.length > 0;
  const modelState = (): AiModelChooserState => ({ status: "ready", models: props.status });
  const [modelChoice, setModelChoice] = createSignal<AiModelRequest | null>(null);
  const selectedModel = createMemo<AiModelRequest>(() => {
    const explicit = modelChoice();
    if (explicit) return explicit;
    const previous = chat
      .messages()
      .findLast((message) => message.kind === "message" && message.message.role === "user" && message.meta?.modelRequest);
    return previous?.meta?.modelRequest ?? props.status.selection ?? props.status.effectiveDefault;
  });

  // While an answer is written, Stop replaces Send; a question that waits for the person leaves the field as it is.
  const [sending, setSending] = createSignal(false);
  const answering = () => chat.runStatus() === "streaming" && !sending();
  const [failed, setFailed] = createSignal<readonly FailedSend[]>([]);
  const dropFailed = (id: string) => setFailed((current) => current.filter((entry) => entry.id !== id));
  /** A chat whose last message was sent without a confirmation; trying again sends the same submission. */
  const [unconfirmed, setUnconfirmed] = createSignal<string | null>(null);
  const retryUnconfirmed = async () => {
    const target = unconfirmed();
    if (!target) return;
    if ((await chat.retrySubmission(target)) === "accepted") {
      setUnconfirmed(null);
      chat.setError(null);
    }
  };
  const [creating, setCreating] = createSignal(false);

  /** Sends to the open chat, or starts a chat first. False keeps the text in the field. */
  const send = async (input: ChatSubmitInput, fromKey = draftKey()): Promise<boolean> => {
    if (!online() || !canUseComposer()) return false;
    // Until the server confirms or refuses the last message, a new one would not reach it; the text stays.
    const open = chat.activeConversationId();
    if (open && chat.uncertainSubmissions()[open] !== undefined) return false;
    setNotice(null);
    let target = chat.activeConversationId();
    if (!target) {
      setCreating(true);
      const created = await chat
        .createConversation({ requestId: crypto.randomUUID(), title: t().newChat })
        .finally(() => setCreating(false));
      if (!created) {
        setNotice(t().createFailed);
        return false;
      }
      target = created.id;
      clearDraft(fromKey);
      go({ level: "chat", id: target });
    }
    const message = { ...aiComposerSendInput(input), conversationId: target, model: selectedModel() };
    setSending(true);
    const sent = await (input.intent === "queue" || chat.running() ? chat.queueMessage(message) : chat.send(message)).finally(() =>
      setSending(false),
    );
    if (sent) {
      clearDraft(target);
      void reloadList(true).catch(() => undefined);
      return true;
    }
    // The message stands in the timeline either way: one without a confirmation tries the same submission again from
    // the hint line, one that never arrived waits there with "Send again".
    chat.setError(null);
    if (chat.uncertainSubmissions()[target] !== undefined) {
      setUnconfirmed(target);
      clearDraft(target);
      return true;
    }
    setFailed((current) => [...current, { id: crypto.randomUUID(), conversationId: target, input }]);
    clearDraft(target);
    return true;
  };

  const addFiles = async (selected: readonly File[]) => {
    const key = draftKey();
    const current = files()[key] ?? [];
    const result = await readAiComposerFiles(selected, {
      acceptsImages: props.status.visionModelConfigured,
      currentCount: current.length,
      currentImageBytes: current.reduce((sum, file) => sum + (file.kind === "image" ? file.size : 0), 0),
    });
    setFiles((all) => ({ ...all, [key]: [...(all[key] ?? []), ...result.attachments] }));
    const reasons = [...result.errors, ...(result.discarded ? [t().discarded({ count: result.discarded })] : [])];
    setNotice(reasons.length ? reasons.join(" ") : null);
  };

  // ---- the open chat
  const open = (conversation: AiConversation, event: LinkNavigateEvent) => go({ level: "chat", id: conversation.id }, event);
  const chatTitle = () => {
    const current = address();
    if (current.level !== "chat") return t().newChat;
    if (missing()) return t().chatUnavailable;
    return (
      (chat.conversation()?.id === current.id ? chat.conversation()?.title : undefined) ??
      list()?.conversations.find((entry) => entry.id === current.id)?.title ??
      ""
    );
  };
  const waiting = createMemo(() =>
    waitingQuestionsView({
      questions: questions(),
      conversationId: chat.activeConversationId(),
      local: chat.activeConversationId() && !chat.loadingConversation() ? (chat.activeTurn()?.blocks ?? []) : null,
    }),
  );
  // The strip stays quiet only while the one open question's answers are in view, as on the web.
  const [timelineViewport, setTimelineViewport] = createSignal<HTMLElement>();
  const [timelineContent, setTimelineContent] = createSignal<HTMLElement>();
  let scrollToAnchor: (anchor: string) => boolean = () => false;
  const waitingFocus = createWaitingQuestionFocus({
    onlyHere: () => waiting().onlyHere,
    viewport: timelineViewport,
    content: timelineContent,
    scrollToAnchor: (anchor) => scrollToAnchor(anchor),
    gone: () => void reloadList(true).catch(() => undefined),
  });
  const jump = (question: AiOpenQuestion) => {
    const here = chat.activeConversationId() === question.conversationId;
    if (!here) go({ level: "chat", id: question.conversationId });
    void waitingFocus.focus(question.anchor, () => chat.activeConversationId() === question.conversationId);
  };
  /**
   * Questions beyond the strip's bounded list belong to chats that wait for the person but show none of their questions
   * in the strip; "more" opens the next of them.
   */
  const showMoreQuestions = () => {
    const listed = new Set(waiting().entries.map((question) => question.conversationId));
    const next = list()?.conversations.find((entry) => entry.runStatus === "needs_attention" && !listed.has(entry.id));
    if (next) go({ level: "chat", id: next.id });
    else {
      const first = waiting().entries[0];
      if (first) jump(first);
    }
  };

  const Hint = () => (
    <Switch>
      <Match when={!canUseComposer()}>
        <span class="assistant-pwa-hint">
          <i class="ti ti-plug-connected-x" aria-hidden="true" /> {t().noAi}
          <Show when={props.canConfigure}>
            <a class="assistant-pwa-hint__link" href="/admin/ai">
              {t().setUp}
            </a>
          </Show>
        </span>
      </Match>
      <Match when={!online()}>
        <span class="assistant-pwa-hint">
          <i class="ti ti-wifi-off" aria-hidden="true" /> {t().offline}
        </span>
      </Match>
      <Match when={unconfirmed() === chat.activeConversationId() && unconfirmed()}>
        <span class="assistant-pwa-hint assistant-pwa-hint--warning" role="alert">
          <i class="ti ti-alert-triangle" aria-hidden="true" /> {t().unconfirmed}
          <button type="button" class="assistant-pwa-hint__link" onClick={() => void retryUnconfirmed()}>
            {t().retry}
          </button>
        </span>
      </Match>
      <Match when={notice()}>
        {(text) => (
          <span class="assistant-pwa-hint assistant-pwa-hint--error" role="alert">
            <i class="ti ti-alert-circle" aria-hidden="true" /> {text()}
          </span>
        )}
      </Match>
      <Match when={chat.error()}>
        {(text) => (
          <span class="assistant-pwa-hint assistant-pwa-hint--error" role="alert">
            <i class="ti ti-alert-circle" aria-hidden="true" /> {text()}
          </span>
        )}
      </Match>
    </Switch>
  );

  const Composer = (composer: { disabled?: boolean }) => (
    <Chat.Composer
      variant="conversation"
      value={text()}
      onValueChange={setText}
      onSubmit={(input) => send(input)}
      state={chat.runStatus() === "stopping" ? "stopping" : answering() ? "running" : creating() || sending() ? "submitting" : "idle"}
      runningSubmitIntent="queue"
      onStop={answering() ? () => void chat.abort() : undefined}
      attachments={aiChatAttachments(attachments())}
      onAttachmentsChange={(next) => setFiles((all) => ({ ...all, [draftKey()]: aiComposerAttachmentRecords(next) }))}
      fileSelection={{
        onSelect: addFiles,
        accept: aiComposerFileAccept,
        disabled: chat.running(),
        label: t().attachFiles,
      }}
      accessory={
        <Show when={waiting().total > 0 && address().level !== "new"}>
          <AssistantWaitingStrip
            view={waiting()}
            conversationId={chat.activeConversationId()}
            quiet={waitingFocus.quiet()}
            onJump={jump}
            onShowMore={showMoreQuestions}
          />
        </Show>
      }
      placeholder={answering() ? t().queue : t().ask({ name: props.name })}
      hint={<Hint />}
      disabled={!canUseComposer() || composer.disabled}
      submitDisabled={!online() || aiModelBlocksSending(modelState(), selectedModel())}
    />
  );

  const Mark = (mark: { large?: boolean }) => (
    <span class="assistant-pwa-mark" data-size={mark.large ? "lg" : undefined} aria-hidden="true">
      <i class={props.icon} />
    </span>
  );

  const StartList = () => (
    <Switch>
      <Match when={listState() === "failed" && !list()}>
        <Placeholder state="error" icon="ti ti-alert-circle" description={t().listFailed} onRetry={retryList} />
      </Match>
      <Match when={listState() === "loading" && !list()}>
        <h2 class="assistant-pwa-section">{t().recent}</h2>
        <SkeletonRows count={RECENT} label={t().loadingChats} />
      </Match>
      <Match when={recent().length === 0}>
        <div class="assistant-pwa-empty">
          <Mark large />
          <h2>{t().emptyTitle}</h2>
          <p>{t().emptyText({ name: props.name })}</p>
          <div class="assistant-pwa-starters">
            <For
              each={[
                { icon: "ti ti-camera", label: t().starterPhoto, text: t().starterPhotoText },
                { icon: "ti ti-mail-forward", label: t().starterMail, text: t().starterMailText },
                { icon: "ti ti-calendar", label: t().starterWeek, text: t().starterWeekText },
              ]}
            >
              {(starter) => (
                <Button variant="secondary" size="sm" disabled={!canUseComposer()} onClick={() => setText(starter.text)}>
                  <i class={starter.icon} aria-hidden="true" /> {starter.label}
                </Button>
              )}
            </For>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <h2 class="assistant-pwa-section">{t().recent}</h2>
        <ChatRows
          chats={recent()}
          questions={questions().items}
          selected={address().level === "chat" ? (address() as { id: string }).id : null}
          now={props.renderedAt}
          timeZone={props.timeZone}
          onOpen={open}
        />
        <Show when={total()}>
          {(count) => (
            <p class="assistant-pwa-all">
              {t().allChats} <span class="assistant-pwa-all__count">{count()}</span>
            </p>
          )}
        </Show>
      </Match>
    </Switch>
  );

  const saveDownload = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[download][href]") : null;
    if (!link || new URL(link.href).origin !== location.origin || !new URL(link.href).pathname.startsWith("/api/ai/")) return;
    event.preventDefault();
    const name = link.getAttribute("download") || link.pathname.split("/").at(-1) || "file";
    void importOnDemand(() => import("@k2b/cloud/browser/files")).then((files) => files?.saveFiles([{ name, content: link.href }]));
  };

  const failedItems = (): ChatTimelineItem[] =>
    failed()
      .filter((pending) => pending.conversationId === chat.activeConversationId())
      .map((pending) => ({
        kind: "message" as const,
        id: `assistant-pwa-failed-send:${pending.id}`,
        role: "user" as const,
        content: pending.input.text,
        attachments: pending.input.attachments,
        status: "error" as const,
        actionDisplay: "inline" as const,
        actions: [
          {
            id: "resend",
            label: t().resend,
            icon: "ti ti-reload",
            // Sending again takes this message's place: a new failure stands in the chat as its own entry.
            onSelect: async () => {
              dropFailed(pending.id);
              if (!(await send(pending.input, pending.conversationId))) setFailed((current) => [...current, pending]);
            },
          },
        ],
      }));

  const Timeline = () => {
    const items = createAiChatTimeline({
      messages: chat.messages,
      activeTurn: chat.activeTurn,
      reconnecting: () => chat.streamStatus() === "reconnecting",
      timeZone: props.timeZone,
    });
    return (
      <Chat.Timeline
        class="assistant-pwa-timeline"
        conversationKey={chat.activeConversationId()}
        // The message sent from here stands in the chat at once and says that it waits for the server.
        items={[
          ...items().map((item) =>
            item.kind === "message" && item.role === "user" && String(item.id).startsWith("pending-")
              ? { ...item, status: "pending" as const }
              : item,
          ),
          ...failedItems(),
        ]}
        loading={chat.loadingConversation()}
        hasMore={chat.hasMoreHistory()}
        loadingOlder={chat.loadingOlder()}
        onLoadOlder={chat.loadOlderMessages}
        onActionError={(error) => chat.setError(error instanceof Error ? error.message : String(error))}
        viewportRef={setTimelineViewport}
        contentRef={setTimelineContent}
        scrollToAnchorRef={(scroll) => {
          scrollToAnchor = scroll;
        }}
      />
    );
  };

  const ChatPane = () => (
    <Switch>
      <Match when={missing()}>
        <div class="assistant-pwa-full">
          <Placeholder
            variant="panel"
            icon="ti ti-lock"
            description={t().chatUnavailableText}
            action={
              <Button variant="secondary" class="assistant-pwa-narrow-only" onClick={() => go({ level: "start" })}>
                {t().backToChats}
              </Button>
            }
          />
        </div>
      </Match>
      <Match when={address().level === "new" || (address().level === "start" && !chat.activeConversationId())}>
        <div class="assistant-pwa-new">
          <div class="assistant-pwa-new__head">
            <Mark large />
          </div>
          <div class="assistant-pwa-new__composer" data-k2b-shell-bottom>
            <Composer />
          </div>
        </div>
      </Match>
      <Match when={true}>
        <div class="assistant-pwa-chat">
          {/* A download link of the chat leads outside the app, where its session does not go; the file is fetched and
              saved instead. */}
          <div class="assistant-pwa-chat__timeline" ref={(element) => element.addEventListener("click", saveDownload)}>
            <Switch>
              <Match when={openFailed()}>
                <Placeholder
                  state="error"
                  icon="ti ti-alert-circle"
                  description={t().chatFailed}
                  onRetry={() => void openChat(chat.activeConversationId()!)}
                />
              </Match>
              <Match when={chat.loadingConversation()}>
                <div class="assistant-pwa-chat-skeleton" role="status" aria-busy="true" aria-label={t().loadingChat}>
                  <Skeleton class="assistant-pwa-skeleton-bubble" />
                  <Skeleton class="assistant-pwa-skeleton-line" />
                  <Skeleton class="assistant-pwa-skeleton-line" />
                  <Skeleton class="assistant-pwa-skeleton-line" />
                </div>
              </Match>
              <Match when={true}>
                <AiChatActionsProvider
                  actions={{
                    actionDisabled: () => chat.runStatus() === "stopping",
                    onCheckAction: (request) => chat.checkAction(request),
                    onApproval: async (request, input) => {
                      if (await chat.respondToApproval(request, input)) return;
                      // The card says itself that the answer is not confirmed; the field's hint line stays free.
                      const reason = chat.error() ?? t().retry;
                      chat.setError(null);
                      throw new Error(reason);
                    },
                    onRetryMessage: async (entry, input) => {
                      if (!(await chat.retryUserMessage(entry.id, { ...input, model: selectedModel() })))
                        throw new Error(chat.error() ?? t().retry);
                    },
                    onRetrySteer: async (block) => {
                      if (!(await chat.retrySteer(block))) throw new Error(chat.error() ?? t().retry);
                    },
                    onContinueTurn: async (message) => {
                      await send({ intent: "send", text: message, attachments: [] });
                    },
                    fileUrl: chat.fileContentUrl,
                  }}
                >
                  <Chat class="assistant-pwa-chat__root">
                    <Timeline />
                  </Chat>
                </AiChatActionsProvider>
              </Match>
            </Switch>
          </div>
          <div class="assistant-pwa-chat__composer" data-k2b-shell-bottom>
            <Composer disabled={chat.loadingConversation() || openFailed()} />
          </div>
        </div>
      </Match>
    </Switch>
  );

  const actions = (): JSX.Element => (
    <IconButtonLink
      label={t().newChat}
      href={newChatHref}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        go({ level: "new" });
      }}
    >
      <i class="ti ti-edit" aria-hidden="true" />
    </IconButtonLink>
  );

  return (
    <div ref={root} class="assistant-pwa">
      <AppWorkspace flat mobileSurface="flush" resizable={false} class="assistant-pwa-workspace">
        <AppWorkspace.Content>
          <AppWorkspace.Main level={level()} onLevelNavigate={back}>
            <AppWorkspace.MainPane
              id="start"
              label={props.name}
              lead={<Mark />}
              href={startHref}
              actions={actions()}
              defaultSize={352}
              minSize={352}
              maxSize={352}
            >
              <div class="assistant-pwa-start">
                <div class="assistant-pwa-list">
                  <StartList />
                </div>
                <div class="assistant-pwa-start__composer assistant-pwa-narrow-only" data-k2b-shell-bottom>
                  <Show when={address().level === "start"}>
                    <Composer disabled={listState() === "loading"} />
                  </Show>
                </div>
              </div>
            </AppWorkspace.MainPane>
            <AppWorkspace.MainPane id="chat" label={chatTitle()} scroll={false}>
              <ChatPane />
            </AppWorkspace.MainPane>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
