import type {
  AiConversation,
  AiConversationTimelineEntry,
  AiOpenQuestion,
  AiOpenQuestions,
  AiStoredMessage,
  AiTurnSnapshot,
} from "@k2b/cloud/ai";
import { createLiveDictationSource } from "@k2b/cloud/ai/browser";
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
import { Link, type LinkNavigateEvent, listenPopState, navigate } from "@k2b/ssr/nav";
import {
  AppWorkspace,
  Button,
  Chat,
  type ChatSubmitInput,
  type ChatTimelineItem,
  Dropdown,
  IconButtonLink,
  MobileShell,
  Placeholder,
  prompts,
  Skeleton,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { assistantApi } from "../api/client";
import { AssistantWaitingStrip, createWaitingQuestionFocus } from "../frontend/AssistantWaitingStrip";
import { createAssistantDictation } from "../frontend/assistant-dictation";
import { createAssistantLiveHub, followAssistantLive, matchesAssistantInvalidation } from "../frontend/assistant-live";
import { audioMessages } from "../frontend/audio-messages";
import { waitingQuestionsView } from "../frontend/waiting-questions";
import { AllChats, type AllChatsSnapshot } from "./AllChats";
import { pwaMessages } from "./messages";
import { createOnline } from "./online";
import { addressHref, allChatsHref, newChatHref, type PwaAddress, pwaAddress, startHref } from "./paths";
import { ChatRows, SkeletonRows } from "./rows";
import { type StoredChatFile, uploadChatFile } from "./upload";

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
  status: AiPeopleModels & {
    enabled: boolean;
    visionModelConfigured: boolean;
    liveDictationAvailable?: boolean;
    audioModelConfigured?: boolean;
  };
  /** Whether the person may set up AI; the link leads to the web's administration. */
  canConfigure: boolean;
  timeZone: string;
  renderedAt: string;
  initialLiveCursor: string;
  initialAddress: PwaAddress;
  /** `null`: the list could not be read. */
  initialSidebar: { conversations: AiConversation[]; questions: AiOpenQuestions } | null;
  initialTotal: number | null;
  /** Every chat or the archive, when the address names it; read by the server. */
  initialAll: AllChatsSnapshot | null;
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
      invalidate: () => {
        setListRevision((value) => value + 1);
        return reloadList(true);
      },
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
  const level = () => (address().level === "start" || address().level === "all" ? "start" : "chat");
  /** What the first column lists: the recent chats, or every chat or the archive, also beside an open chat. */
  const [listView, setListView] = createSignal<{ archived: boolean } | null>(
    props.initialAddress.level === "all" ? { archived: props.initialAddress.archived } : null,
  );
  const [listRevision, setListRevision] = createSignal(0);
  // On a phone a chat is a screen of its own: the tab bar steps aside. The server renders the first state.
  createEffect(on(level, (current) => root && MobileShell.setScreen(root, current === "chat"), { defer: true }));

  const show = (next: PwaAddress) => {
    // The address first: a list that opens reads its search from it.
    setAddress(next);
    if (next.level === "start") setListView(null);
    if (next.level === "all") setListView({ archived: next.archived });
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
  onMount(() => onCleanup(listenPopState(({ url }) => show(pwaAddress(url) ?? { level: "start" }))));
  // Each step records where it came from, so Back returns there through history and Forward can come back.
  const go = (next: PwaAddress, event?: LinkNavigateEvent) => {
    const state = { assistantFrom: addressHref(address()) };
    show(next);
    const href = addressHref(next);
    if (event) event.push(href, { scroll: "manual", state });
    else navigate(href, { scroll: "manual", state });
  };
  /** Up from a chat or a list: the page it came from, or for a direct link its parent. */
  const back = (event: LinkNavigateEvent) => {
    const target = pwaAddress(event.url) ?? { level: "start" as const };
    const state: unknown = history.state;
    if (state && typeof state === "object" && "assistantFrom" in state && state.assistantFrom === addressHref(target)) {
      history.back();
      return;
    }
    show(target);
    event.replaceWith(addressHref(target), { scroll: "manual", state: null });
  };
  /**
   * What every chat starts from: the server's read on the first visit to the address it rendered, otherwise the
   * current address's search, which the list then reads itself, also after Back.
   */
  let snapshotUsed = false;
  const allChatsSnapshot = (archived: boolean): AllChatsSnapshot => {
    const current = address();
    const query = current.level === "all" ? current.query : "";
    const initial = props.initialAll;
    if (
      !snapshotUsed &&
      initial &&
      props.initialAddress.level === "all" &&
      props.initialAddress.archived === archived &&
      initial.query === query
    ) {
      snapshotUsed = true;
      return initial;
    }
    return { query };
  };
  /** A search keeps its query in the address, without a step of its own in history. */
  const changeQuery = (query: string) => {
    const view = listView();
    if (!view || address().level !== "all") return;
    const next: PwaAddress = { level: "all", archived: view.archived, query };
    setAddress(next);
    // Commit before results load: reload or opening a result must keep this search.
    navigate(addressHref(next), { replace: true, scroll: "manual", state: history.state, viewTransition: false });
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
  const writeText = (key: string, value: string) => {
    setTexts((current) => ({ ...current, [key]: value }));
    pwaDrafts.write(props.userId, `assistant.composer:${key}`, value);
  };
  const setText = (value: string) => writeText(draftKey(), value);
  /**
   * What this device kept for a field wins over the chat's saved draft, also when it is empty. Without one, the
   * chat's saved draft fills the field once the chat has loaded.
   */
  const restoreDraft = (key: string) => {
    const kept = pwaDrafts.read(props.userId, `assistant.composer:${key}`);
    if (kept !== undefined) setTexts((current) => ({ ...current, [key]: kept }));
  };
  // Restored after mounting, so the server and the first frame show the same field.
  onMount(() => restoreDraft(draftKey()));
  createEffect(on(draftKey, (key) => restoreDraft(key), { defer: true }));
  createEffect(() => {
    const key = draftKey();
    if (key === NEW_DRAFT || chat.loadingConversation() || chat.conversation()?.id !== key) return;
    if (untrack(texts)[key] === undefined) setTexts((current) => ({ ...current, [key]: serverDraft(key) }));
  });
  const attachments = () => files()[draftKey()] ?? [];
  const clearDraft = (key: string) => {
    for (const record of files()[key] ?? []) setUpload(record.id, null);
    setTexts((current) => ({ ...current, [key]: "" }));
    setFiles((current) => ({ ...current, [key]: [] }));
    pwaDrafts.remove(props.userId, `assistant.composer:${key}`);
  };

  const liveDictation = createLiveDictationSource({ app: "assistant" });
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
  /** The open chat when its last message was sent without a confirmation; trying again sends the same submission. */
  const unconfirmed = () => {
    const id = chat.activeConversationId();
    return id && chat.uncertainSubmissions()[id] !== undefined ? id : null;
  };
  const retryUnconfirmed = async () => {
    const target = unconfirmed();
    if (target && (await chat.retrySubmission(target)) === "accepted") chat.setError(null);
  };
  const [creating, setCreating] = createSignal(false);

  /**
   * Sends to the open chat, or starts a chat first. False keeps the text in the field. `fromField` is false for a
   * message sent again from the timeline: the field holds other text then, which stays.
   */
  const send = async (input: ChatSubmitInput, fromField = true): Promise<boolean> => {
    const fromKey = draftKey();
    const clearField = (key: string) => fromField && clearDraft(key);
    if (!online() || !canUseComposer() || recorder.busy()) return false;
    // A recording that finishes later no longer lands in a field that was sent meanwhile.
    recorder.invalidateAutomatic();
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
      clearField(fromKey);
      go({ level: "chat", id: target });
    }
    setSending(true);
    const message = { ...(await withUploadedFiles(input)), conversationId: target, model: selectedModel() };
    const sent = await (input.intent === "queue" || chat.running() ? chat.queueMessage(message) : chat.send(message)).finally(() =>
      setSending(false),
    );
    if (sent) {
      clearField(target);
      void reloadList(true).catch(() => undefined);
      return true;
    }
    // The message stands in the timeline either way: one without a confirmation tries the same submission again from
    // the hint line, one that never arrived waits there with "Send again".
    chat.setError(null);
    if (chat.uncertainSubmissions()[target] !== undefined) {
      clearField(target);
      return true;
    }
    setFailed((current) => [...current, { id: crypto.randomUUID(), conversationId: target, input }]);
    clearField(target);
    return true;
  };

  // ---- attachments of an open chat upload while the person writes, so sending does not wait for them. Each shows its
  // progress, a failure with "Upload again", or offline that it waits for the network; with the network back the
  // waiting ones go on by themselves. A new chat has no place for files yet: its files upload when it is sent.
  type Upload =
    | { state: "uploading"; progress: number; done: Promise<StoredChatFile | null> }
    | { state: "failed" | "waiting" }
    | { state: "done"; file: StoredChatFile };
  const [uploads, setUploads] = createSignal<Record<string, Upload>>({});
  const setUpload = (id: string, upload: Upload | null) =>
    setUploads((current) => {
      const next = { ...current };
      if (upload) next[id] = upload;
      else delete next[id];
      return next;
    });
  const uploadable = (record: AiComposerAttachment): record is Extract<AiComposerAttachment, { kind: "image" | "file" }> =>
    record.kind === "image" || record.kind === "file";
  const startUpload = (conversationId: string, record: AiComposerAttachment) => {
    if (!uploadable(record)) return;
    if (!navigator.onLine) {
      setUpload(record.id, { state: "waiting" });
      return;
    }
    const done = uploadChatFile(conversationId, record.file, (progress) => {
      const current = uploads()[record.id];
      if (current?.state === "uploading") setUpload(record.id, { ...current, progress });
    }).then(
      (file) => {
        if (uploads()[record.id]) setUpload(record.id, { state: "done", file });
        return file;
      },
      () => {
        if (uploads()[record.id]) setUpload(record.id, { state: navigator.onLine ? "failed" : "waiting" });
        return null;
      },
    );
    setUpload(record.id, { state: "uploading", progress: 0, done });
  };
  onMount(() => {
    const resume = () => {
      const key = draftKey();
      if (key === NEW_DRAFT) return;
      for (const record of files()[key] ?? []) if (uploads()[record.id]?.state === "waiting") startUpload(key, record);
    };
    window.addEventListener("online", resume);
    onCleanup(() => window.removeEventListener("online", resume));
  });
  /** What the field shows of each attachment: its upload's progress or state, otherwise the attachment itself. */
  const shownAttachments = () =>
    aiChatAttachments(attachments()).map((attachment) => {
      const upload = uploads()[attachment.id];
      const key = draftKey();
      const record = attachments().find((entry) => entry.id === attachment.id);
      if (upload?.state === "uploading") return { ...attachment, progress: upload.progress };
      if (upload?.state === "failed" && record)
        return {
          ...attachment,
          action: {
            id: "upload-again",
            label: t().uploadAgain,
            icon: "ti ti-alert-circle",
            variant: "danger" as const,
            onSelect: () => startUpload(key, record),
          },
        };
      if (upload?.state === "waiting")
        return {
          ...attachment,
          action: { id: "waiting", label: t().waitingForNetwork, icon: "ti ti-wifi-off", disabled: true, onSelect: () => {} },
        };
      return attachment;
    });
  /** The send input with every file already in the chat sent by reference; the rest uploads with the message. */
  const withUploadedFiles = async (input: ChatSubmitInput) => {
    const records = aiComposerAttachmentRecords(input.attachments);
    const stored: StoredChatFile[] = [];
    const pending = new Set<File>();
    for (const record of records) {
      const upload = uploads()[record.id];
      const file = upload?.state === "uploading" ? await upload.done : upload?.state === "done" ? upload.file : null;
      if (file && uploadable(record)) {
        stored.push(file);
        pending.add(record.file);
      }
    }
    const message = aiComposerSendInput(input);
    const files = message.files?.filter((file) => !pending.has(file));
    return {
      ...message,
      files: files?.length ? files : undefined,
      storedFiles: [...(message.storedFiles ?? []), ...stored].length ? [...(message.storedFiles ?? []), ...stored] : undefined,
    };
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
    if (key !== NEW_DRAFT) for (const record of result.attachments) startUpload(key, record);
    const reasons = [...result.errors, ...(result.discarded ? [t().discarded({ count: result.discarded })] : [])];
    setNotice(reasons.length ? reasons.join(" ") : null);
  };

  // ---- a recording instead of live dictation: its text appears after Stop. The server keeps the recording with the
  // chat and inserts its text into the chat's saved draft; the field here lives on the device, so inserting saves the
  // field's text as that draft first and then takes the draft's text with the recording back into the field.
  const audio = () => audioMessages.resolve([locale()]).t;
  const recordingTarget = () => {
    const key = draftKey();
    return props.status.audioModelConfigured && online() && key !== NEW_DRAFT && chat.conversation()?.id === key ? key : null;
  };
  const recorder = createAssistantDictation({
    configured: () => Boolean(props.status.audioModelConfigured) && canUseComposer() && online(),
    key: draftKey,
    target: recordingTarget,
    // The field's text is taken along when the recording is inserted, so later edits never block inserting.
    generation: () => 0,
    live: liveHub,
    quiet: true,
    ensureTarget: async () => {
      const key = draftKey();
      if (key !== NEW_DRAFT) return recordingTarget() ? { key, target: key } : null;
      // A recording needs its chat first, as sending does; the field's text and files move along into it.
      setCreating(true);
      const created = await chat
        .createConversation({ requestId: crypto.randomUUID(), title: t().newChat })
        .finally(() => setCreating(false));
      if (!created) {
        setNotice(t().createFailed);
        return null;
      }
      const moved = files()[NEW_DRAFT] ?? [];
      writeText(created.id, texts()[NEW_DRAFT] ?? "");
      setFiles((current) => ({ ...current, [created.id]: moved, [NEW_DRAFT]: [] }));
      setTexts((current) => ({ ...current, [NEW_DRAFT]: "" }));
      pwaDrafts.remove(props.userId, `assistant.composer:${NEW_DRAFT}`);
      for (const record of moved) startUpload(created.id, record);
      go({ level: "chat", id: created.id });
      return { key: created.id, target: created.id };
    },
    apply: async (key, target, id) => {
      if (chat.activeConversationId() !== target) return false;
      // The saved draft moved on; the next message reads its revision again. A failed read changes nothing here.
      const refresh = () => chat.refreshActiveConversation().catch(() => false);
      const append = (addition: string) => {
        const now = texts()[key] ?? "";
        writeText(key, [now.trimEnd(), addition].filter(Boolean).join("\n\n"));
      };
      // An earlier try may have inserted the recording without its answer arriving: then the field takes the
      // recording's own text, and the device's text never writes over the saved draft that already holds it.
      const before = await fetch(`/api/ai/conversations/${target}/dictations/${id}`).then(
        (response) => (response.ok ? (response.json() as Promise<{ disposition: string; text?: string | null }>) : null),
        () => null,
      );
      if (!before) return false;
      if (before.disposition === "applied") {
        if (before.text) append(before.text);
        await refresh();
        return true;
      }
      if (before.disposition !== "pending") return true;
      const sent = (texts()[key] ?? "").trim();
      const saved = await chat.saveDraft({ conversationId: target, message: sent });
      if (!saved) {
        await refresh();
        return false;
      }
      const response = await fetch(`/api/ai/conversations/${target}/dictations/${id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: saved.revision, content: saved.content }),
      });
      if (!response.ok) {
        await refresh();
        return false;
      }
      const result: { disposition: string; draft: AiConversation["draft"] | null } = await response.json();
      // The field takes the text first, so a failed refresh afterwards cannot lose it.
      if (result.draft) {
        const inserted = result.draft.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
        // Text typed while the recording was inserted stays; the recording's text follows it.
        const now = texts()[key] ?? "";
        if (now.trim() === sent) writeText(key, inserted);
        else append(sent && inserted.startsWith(sent) ? inserted.slice(sent.length).replace(/^\n+/, "") : inserted);
      } else if (result.disposition === "applied" && before.text) append(before.text);
      await refresh();
      return result.disposition === "applied";
    },
  });
  /** Above the field: the recording's level with Discard and Stop, then its text on the way, a failure, or the result. */
  const Recording = () => (
    <Show when={recorder.recording() || recorder.processing() || recorder.problem() || recorder.pendingResult()}>
      <div class="assistant-pwa-recording">
        <Switch fallback={<recorder.Status />}>
          <Match when={recorder.recording()}>
            <recorder.RecordingFooter />
          </Match>
          <Match when={recorder.problem()}>
            {(problem) => (
              <>
                <recorder.Control />
                <span class="assistant-pwa-recording__text" role="alert">
                  {problem()}
                </span>
              </>
            )}
          </Match>
          <Match when={recorder.processing()}>
            <recorder.Control />
            <span class="assistant-pwa-recording__text">{audio().processing}</span>
          </Match>
        </Switch>
      </div>
    </Show>
  );

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
      <Match when={recorder.recording()}>
        <span class="assistant-pwa-hint">
          <i class="ti ti-microphone" aria-hidden="true" /> {t().recording}
        </span>
      </Match>
      <Match when={recorder.processing()}>
        <span class="assistant-pwa-hint">
          <i class="ti ti-microphone" aria-hidden="true" /> {t().transcribing}
        </span>
      </Match>
      <Match when={menuNotice()}>
        {(notice) => (
          <span class={`assistant-pwa-hint assistant-pwa-hint--${notice().tone}`} role="alert">
            <i class={notice().tone === "error" ? "ti ti-alert-circle" : "ti ti-alert-triangle"} aria-hidden="true" /> {notice().text}
            <button type="button" class="assistant-pwa-hint__link" onClick={() => notice().retry()}>
              {t().retry}
            </button>
          </span>
        )}
      </Match>
      <Match when={unconfirmed()}>
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
      attachments={shownAttachments()}
      onAttachmentsChange={(next) => setFiles((all) => ({ ...all, [draftKey()]: aiComposerAttachmentRecords(next) }))}
      fileSelection={{
        onSelect: addFiles,
        accept: aiComposerFileAccept,
        disabled: chat.running(),
        label: t().attachFiles,
      }}
      accessory={
        <>
          <Show when={waiting().total > 0 && address().level !== "new"}>
            <AssistantWaitingStrip
              view={waiting()}
              conversationId={chat.activeConversationId()}
              quiet={waitingFocus.quiet()}
              onJump={jump}
              onShowMore={showMoreQuestions}
            />
          </Show>
          <Recording />
        </>
      }
      // Live dictation writes into the field as on the web; offline and with a blocked microphone the button and its
      // card say why it waits. While a recording runs or its text waits, the microphone steps aside, as on the web.
      dictation={
        props.status.liveDictationAvailable && canUseComposer() && !recorder.busy() && !recorder.pendingResult()
          ? {
              source: liveDictation,
              alternative: props.status.audioModelConfigured
                ? { label: audio().recordInstead, note: audio().recordInsteadNote, run: () => void recorder.startRecording() }
                : undefined,
            }
          : undefined
      }
      // Without live dictation the microphone records instead, as the web's does; its text appears after Stop.
      microphone={
        !props.status.liveDictationAvailable &&
        props.status.audioModelConfigured &&
        canUseComposer() &&
        !recorder.busy() &&
        !recorder.pendingResult()
          ? { onDictate: () => void recorder.startRecording(), disabled: !online() }
          : undefined
      }
      placeholder={answering() ? t().queue : t().ask({ name: props.name })}
      hint={<Hint />}
      disabled={!canUseComposer() || composer.disabled}
      submitDisabled={!online() || recorder.busy() || aiModelBlocksSending(modelState(), selectedModel())}
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
            <Link
              class="assistant-pwa-all"
              href={allChatsHref}
              onNavigate={(event) => go({ level: "all", archived: false, query: "" }, event)}
            >
              {t().allChats} <span class="assistant-pwa-all__count">{count()}</span>
              <i class="ti ti-chevron-right assistant-pwa-all__chevron" aria-hidden="true" />
            </Link>
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
              if (!(await send(pending.input, false))) setFailed((current) => [...current, pending]);
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
      <Match when={address().level === "new" || (address().level !== "chat" && !chat.activeConversationId())}>
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
                    onEditDraft: (request, values, digest) => chat.editDraft(request, values, digest),
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
                      await send({ intent: "send", text: message, attachments: [] }, false);
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

  const newChatButton = () => (
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
  // Beside every chat the search field is already in view, so the head drops its magnifier there.
  const actions = (): JSX.Element => (
    <>
      <Show when={!listView()}>
        <IconButtonLink
          label={t().searchChats}
          href={allChatsHref}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            go({ level: "all", archived: false, query: "" });
          }}
        >
          <i class="ti ti-search" aria-hidden="true" />
        </IconButtonLink>
      </Show>
      {newChatButton()}
    </>
  );

  // ---- "…" of a chat: rename, pin, archive. A failure stays in the field's hint line, where it moves nothing; a
  // refusal says it failed, a missing answer that it is not confirmed. Each can be tried again, because doing it twice
  // changes nothing.
  const [menuNotice, setMenuNotice] = createSignal<{ text: string; tone: "error" | "warning"; retry: () => void } | null>(null);
  const mutate = async (label: string, run: () => Promise<void>) => {
    setMenuNotice(null);
    try {
      await run();
      setListRevision((value) => value + 1);
      void reloadList(true).catch(() => undefined);
    } catch (error) {
      const unconfirmed = error instanceof TypeError || !navigator.onLine;
      setMenuNotice({
        text: unconfirmed ? t().unconfirmedAction({ action: label }) : t().failedAction({ action: label }),
        tone: unconfirmed ? "warning" : "error",
        retry: () => void mutate(label, run),
      });
    }
  };
  const openConversation = () => {
    const current = address();
    return current.level === "chat" ? (chat.conversation() ?? list()?.conversations.find((entry) => entry.id === current.id)) : undefined;
  };
  const rename = async () => {
    const conversation = openConversation();
    const id = chat.activeConversationId();
    if (!conversation || !id) return;
    const title = await prompts.prompt(t().renamePrompt, conversation.title, { title: t().renameTitle });
    if (!title?.trim() || title.trim() === conversation.title) return;
    await mutate(t().rename, async () => {
      await assistantApi.updateConversation(id, { title: title.trim() });
      await chat.refreshActiveConversation();
    });
  };
  const togglePin = () => {
    const conversation = openConversation();
    const id = chat.activeConversationId();
    if (!conversation || !id) return;
    const pinned = !conversation.pinnedAt;
    void mutate(pinned ? t().pin : t().unpin, async () => {
      await assistantApi.setConversationPinned(id, pinned);
      await chat.refreshActiveConversation();
    });
  };
  const archive = () => {
    const conversation = openConversation();
    const id = chat.activeConversationId();
    if (!conversation || !id) return;
    void mutate(t().archiveChat, async () => {
      await assistantApi.archiveConversation(id);
      // Back to the list, which no longer shows the chat; a short note offers the way back and moves nothing.
      const view = listView();
      const target: PwaAddress = view ? { level: "all", archived: view.archived, query: "" } : { level: "start" };
      show(target);
      navigate(addressHref(target), { replace: true, scroll: "manual", state: null });
      toast.success(t().archived({ title: conversation.title }), {
        action: {
          label: t().undo,
          onClick: () =>
            void mutate(t().restore, async () => {
              await assistantApi.restoreConversation(id);
              go({ level: "chat", id });
            }),
        },
      });
    });
  };
  const chatMenu = () => {
    const pinned = Boolean(openConversation()?.pinnedAt);
    // Offline each entry would change the chat on the server, so each waits; the section says why.
    const offline = !online();
    const items = [
      { label: t().rename, icon: "ti ti-pencil", disabled: offline, action: () => void rename() },
      { label: pinned ? t().unpin : t().pin, icon: pinned ? "ti ti-pinned-off" : "ti ti-pin", disabled: offline, action: togglePin },
      { label: t().archiveChat, icon: "ti ti-archive", disabled: offline, action: archive },
    ];
    return (
      <Dropdown.Root
        position="bottom-right"
        items={offline ? [{ sectionLabel: t().offlineSection, items }] : items}
        phone="sheet"
        variant="touch"
        sheetTop={() => <p class="assistant-pwa-sheet-title">{chatTitle()}</p>}
      >
        <Dropdown.Trigger iconOnly label={t().more}>
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    );
  };

  return (
    <div ref={root} class="assistant-pwa">
      <AppWorkspace flat mobileSurface="flush" resizable={false} class="assistant-pwa-workspace">
        <AppWorkspace.Content>
          <AppWorkspace.Main level={level()} onLevelNavigate={back}>
            <AppWorkspace.MainPane
              id="start"
              label={listView() ? (listView()!.archived ? t().archive : t().allChats) : props.name}
              lead={listView() ? undefined : <Mark />}
              href={listView() ? addressHref({ level: "all", archived: listView()!.archived, query: "" }) : startHref}
              back={
                listView()
                  ? listView()!.archived
                    ? { href: allChatsHref, label: t().allChats }
                    : { href: startHref, label: props.name }
                  : undefined
              }
              actions={actions()}
              defaultSize={352}
              minSize={352}
              maxSize={352}
            >
              <Show
                when={listView()}
                keyed
                fallback={
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
                }
              >
                {(view) => (
                  <AllChats
                    archived={view.archived}
                    initial={allChatsSnapshot(view.archived)}
                    questions={questions().items}
                    selected={address().level === "chat" ? (address() as { id: string }).id : null}
                    now={props.renderedAt}
                    timeZone={props.timeZone}
                    online={online()}
                    onOpen={open}
                    onQueryChange={changeQuery}
                    onArchive={(event) => go({ level: "all", archived: true, query: "" }, event)}
                    revision={listRevision()}
                  />
                )}
              </Show>
            </AppWorkspace.MainPane>
            <AppWorkspace.MainPane
              id="chat"
              label={chatTitle()}
              scroll={false}
              actions={address().level === "chat" && !missing() && !openFailed() ? chatMenu() : undefined}
            >
              <ChatPane />
            </AppWorkspace.MainPane>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
