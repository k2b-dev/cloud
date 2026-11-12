import { type DateContext, dates } from "@k2b/stdlib";
import { announce, Button, Dropdown, type DropdownItem, Placeholder, prompts, TextInput, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationDraftSummary, MailDraft, MailDraftSeed, SenderIdentity } from "../../contracts";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import type { ConversationComment } from "../../service/collaboration";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import type { MailComposerHost, MailInlineDraftControls } from "./MailComposer";
import { preloadMailComposerEditor } from "./MailComposerEditor";
import { chooseScheduledSendTime } from "./MailScheduleDialog";
import { deriveReplyIdentityId, forwardMessageBody, forwardSubject, replySubject } from "./mail-compose-derivation";
import { draftWindowOpen, openDraftWindow, recallDraftWindow } from "./mail-compose-windows";
import type { UnfinishedDraftUpload } from "./mail-composer-attachment-manager";
import { createDefaultMailComposerPanesLayout } from "./mail-composer-panes";
import type { MailComposerSignatures } from "./mail-composer-signature";
import { messageDeliveryAllowsResponses } from "./mail-message-presentation";
import {
  isMailReplyMailMode,
  type MailReplyBoxPart,
  type MailReplyMailMode,
  type MailReplyMode,
  mailReplyBoxKey,
  readMailReplyNote,
  replyBoxDelivery,
  writeMailReplyNote,
} from "./mail-reply-box";
import { mailReplyBoxMessages } from "./mail-reply-box-messages";

type ComposerModule = typeof import("./MailComposer");
type ComposerParts = { Composer: ComposerModule["default"]; signatures: MailComposerSignatures };

// One mailbox's composer code and signatures, loaded once per page: every conversation shows a box, most never write.
const composerParts = new Map<string, Promise<ComposerParts>>();
const loadComposerParts = (mailboxId: string): Promise<ComposerParts> => {
  const cached = composerParts.get(mailboxId);
  if (cached) return cached;
  const loading = (async () => {
    const param = { mailboxId };
    // The editor loads with the composer, so the text does not appear a moment after the box.
    const [composer, , templatesResponse, defaultsResponse] = await Promise.all([
      import("./MailComposer"),
      preloadMailComposerEditor(),
      apiClient.mailboxes[":mailboxId"]["compose-templates"].$get({ param }),
      apiClient.mailboxes[":mailboxId"]["compose-signature-defaults"].$get({ param }),
    ]);
    // Signatures make the reply complete, but a box without them is still safe to write in.
    const templates = templatesResponse.ok ? await templatesResponse.json() : [];
    const defaults = defaultsResponse.ok ? await defaultsResponse.json() : [];
    return {
      Composer: composer.default,
      signatures: {
        templates: templates.filter((template) => template.kind === "signature").map(({ id, name }) => ({ id, name })),
        personalDefaults: defaults
          .filter((entry) => entry.userId !== null)
          .map(({ senderIdentityId, templateId }) => ({ senderIdentityId, templateId })),
      },
    };
  })();
  composerParts.set(mailboxId, loading);
  loading.catch(() => composerParts.delete(mailboxId));
  return loading;
};

/** What the box writes into: the conversation's reply draft, or a local seed that becomes it on the first save. */
type Mount =
  | { key: number; kind: "draft"; draft: MailDraft; uploads: UnfinishedDraftUpload[]; parts: ComposerParts; autofocus: boolean }
  | { key: number; kind: "seed"; seed: MailDraftSeed; parts: ComposerParts; autofocus: boolean };

/** Work the box hands to the next mounted draft once it takes input. */
type PendingAction = { kind: "append"; text: string } | { kind: "sendAt"; at: string } | { kind: "focus" };

class NoVerifiedSender extends Error {}

/** What the reader asks of the box: Reply, Reply all, Forward, a quote, or a draft that must stand in it. */
export type MailReplyBoxApi = {
  open: (mode: MailReplyMode, options?: { message?: MailWorkspaceMessage; quote?: string }) => void;
  openDraft: (draftId: string) => void;
};

/**
 * The reply box under the conversation (Mail v5): always open, one reply draft per conversation, and the internal note.
 *
 * Opening a conversation creates no draft. Without one, the box writes into a seed the server derived (recipients,
 * subject, sender); the first autosave creates the draft. The three mail modes switch the draft through the mode API and
 * keep its text. "Internal note" hides the draft (inert, and its Send refuses while suspended) and writes its own text
 * through the comments API only; note text never reaches the draft, and mail modes never create a comment.
 */
export default function MailReplyBox(props: {
  mailboxId: string;
  conversationId: string;
  subject: string;
  messages: MailWorkspaceMessage[];
  conversationDrafts: ConversationDraftSummary[];
  identities: SenderIdentity[];
  canReplyAll: boolean;
  /** Who the customer is, for "… never sees it". */
  customerName: string | null;
  currentUserId: string;
  currentUserEmail: string | null;
  dateConfig: DateContext;
  canAdmin: boolean;
  mailboxRecipientSuggestions: boolean;
  calendarIntegrationAvailable: boolean;
  liveDictation: boolean;
  returnHref: string;
  messageLabel: (messageId: string) => string | null;
  createNote: (body: string, failed: string) => Promise<ConversationComment>;
  onReconcile: () => Promise<void>;
  onExplainSenderUnavailable: () => void;
  register: (api: MailReplyBoxApi) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailReplyBoxMessages.resolve([locale()]).t);
  const replyDraft = () => props.conversationDrafts.find((draft) => draft.intent !== "new") ?? null;
  // Local box text belongs to the signed-in person: it lives in their Mail storage, which signing out clears.
  const boxStorage = (): Storage | null => {
    try {
      return typeof window === "undefined" || !props.currentUserId ? null : openMailUserDraftStorage(localStorage, props.currentUserId);
    } catch {
      return null;
    }
  };
  const storedText = (part: MailReplyBoxPart) =>
    readMailReplyNote(boxStorage(), mailReplyBoxKey(props.mailboxId, props.conversationId, part));
  const storeText = (part: MailReplyBoxPart, text: string) =>
    writeMailReplyNote(boxStorage(), mailReplyBoxKey(props.mailboxId, props.conversationId, part), text);

  // Unsaved note text from earlier brings the box back in note mode.
  const storedNote = storedText("note");
  const initialMailMode = (): MailReplyMailMode => {
    const intent = replyDraft()?.intent;
    return intent && isMailReplyMailMode(intent) ? intent : "reply";
  };
  const [mode, setMode] = createSignal<MailReplyMode>(storedNote ? "note" : initialMailMode());
  const [mailMode, setMailMode] = createSignal<MailReplyMailMode>(initialMailMode());
  const [noteText, setNoteText] = createSignal(storedNote);
  const [noteSaving, setNoteSaving] = createSignal(false);
  const [noteError, setNoteError] = createSignal<string | null>(null);
  const [noteMinHeight, setNoteMinHeight] = createSignal<number | null>(null);
  const [mount, setMount] = createSignal<Mount | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [noSender, setNoSender] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  /** The draft this box handed to a compose window; the box shows a line to bring it back while the window holds it. */
  const [detachedId, setDetachedId] = createSignal<string | null>(null);
  const detached = () => {
    const id = detachedId();
    return id !== null && draftWindowOpen(id);
  };
  const [justSent, setJustSent] = createSignal(false);
  // Text written while the last reply waited to send, after Undo brought that reply back: kept until restored or dropped.
  const [meanwhile, setMeanwhileSignal] = createSignal<string | null>(storedText("meanwhile") || null);
  const setMeanwhile = (text: string | null) => {
    setMeanwhileSignal(text);
    storeText("meanwhile", text ?? "");
  };
  const [switchError, setSwitchError] = createSignal<string | null>(null);
  const [consolidated, setConsolidated] = createSignal(0);
  const [pending, setPending] = createSignal<PendingAction | null>(null);
  const [controls, setControls] = createSignal<MailInlineDraftControls | null>(null);
  const [scheduledBusy, setScheduledBusy] = createSignal(false);
  /** The draft id the mounted composer writes, also after its seed became a draft. */
  const [draftId, setDraftId] = createSignal<string | null>(null);
  // Drafts that left this box (sent or discarded here); the list may name them until its next refresh.
  const gone = new Set<string>();
  let mountKey = 0;
  let loadGeneration = 0;
  /** A load is on its way; a state change meanwhile must not start a second one that would replace it. */
  let loading = false;
  let disposed = false;
  let frame: HTMLDivElement | undefined;
  let noteField: HTMLTextAreaElement | undefined;
  onCleanup(() => {
    disposed = true;
    loadGeneration++;
  });

  const delivery = createMemo(() => replyBoxDelivery(props.messages));
  /** Another send holds the conversation's one reply place: type locally, create the next draft after it left. */
  const hold = () => justSent() || delivery()?.kind === "hold";
  const scheduled = () => {
    const current = delivery();
    return current?.kind === "scheduled" ? current : null;
  };
  /** The message a new reply answers: the newest one that can be answered. */
  const sourceMessage = () =>
    props.messages.findLast((message) => !message.delivery || messageDeliveryAllowsResponses(message.delivery.state)) ??
    props.messages.at(-1) ??
    null;

  const verifiedIdentity = (message: MailWorkspaceMessage): string | null => {
    const derived = deriveReplyIdentityId(message, props.identities);
    if (derived) return derived;
    const verified = props.identities.filter((identity) => identity.status === "verified");
    return (verified.find((identity) => identity.isDefault) ?? verified[0])?.id ?? null;
  };

  const prepareSeed = async (intent: MailReplyMailMode, message: MailWorkspaceMessage, withText: boolean): Promise<MailDraftSeed> => {
    const senderIdentityId = verifiedIdentity(message);
    if (!senderIdentityId) throw new NoVerifiedSender();
    const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post({
      param: { mailboxId: props.mailboxId },
      json: {
        origin: {
          kind: "compose",
          input: {
            senderIdentityId,
            to: [],
            cc: [],
            bcc: [],
            subject: intent === "forward" ? forwardSubject(props.subject) : replySubject(props.subject),
            // A fresh forward carries the forwarded text; text typed before the switch stays the only text.
            body: intent === "forward" && !withText ? forwardMessageBody(message, props.dateConfig, locale()) : "",
            conversationId: props.conversationId,
            intent,
            sourceMessageId: message.id,
            includeSourceAttachments: intent === "forward" && message.attachments.length > 0,
          },
        },
      },
    });
    if (!response.ok) throw new Error(await readApiError(response, t().loadFailed));
    return response.json();
  };

  const loadDraft = async (id: string, known?: MailDraft): Promise<{ draft: MailDraft; uploads: UnfinishedDraftUpload[] }> => {
    const param = { mailboxId: props.mailboxId, draftId: id };
    const [draftResponse, uploadsResponse] = await Promise.all([
      known ? null : apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({ param }),
      apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["attachment-uploads"].$get({ param }),
    ]);
    if (draftResponse && !draftResponse.ok) throw new Error(await readApiError(draftResponse, t().loadFailed));
    const draft = draftResponse ? await draftResponse.json() : known!;
    const uploads = uploadsResponse.ok ? await uploadsResponse.json() : [];
    return { draft, uploads: uploads.map(({ id, filename, byteLength, receivedBytes }) => ({ id, filename, byteLength, receivedBytes })) };
  };

  /** Mounts the composer for a draft or a fresh seed; a newer request replaces an older one still loading. */
  const load = async (
    target:
      | { kind: "draft"; id: string; known?: MailDraft }
      | { kind: "seed"; intent: MailReplyMailMode; message: MailWorkspaceMessage; withText: boolean },
    options: { autofocus?: boolean } = {},
  ): Promise<boolean> => {
    const generation = ++loadGeneration;
    loading = true;
    batch(() => {
      setControls(null);
      setMount(null);
      setLoadError(null);
      setNoSender(false);
    });
    try {
      const parts = await loadComposerParts(props.mailboxId);
      if (target.kind === "draft") {
        const loaded = await loadDraft(target.id, target.known);
        if (disposed || generation !== loadGeneration) return false;
        const intent = loaded.draft.intent;
        batch(() => {
          if (isMailReplyMailMode(intent)) setMailMode(intent);
          setDraftId(loaded.draft.id);
          setConsolidated(loaded.draft.consolidatedCount ?? 0);
          setMount({ key: ++mountKey, kind: "draft", ...loaded, parts, autofocus: Boolean(options.autofocus) });
        });
        // Text kept from a held place meets a draft now: it waits as a copy to restore, never mixed in by itself.
        const buffered = storedText("pending");
        if (buffered.trim()) {
          storeText("pending", "");
          setMeanwhile([meanwhile(), buffered.trim()].filter(Boolean).join("\n\n"));
        }
        return true;
      }
      const seed = await prepareSeed(target.intent, target.message, target.withText);
      if (disposed || generation !== loadGeneration) return false;
      // Read before the composer mounts: text typed while an earlier send held the place.
      const buffered = storedText("pending");
      batch(() => {
        setMailMode(target.intent);
        setDraftId(null);
        setConsolidated(0);
        setMount({ key: ++mountKey, kind: "seed", seed, parts, autofocus: Boolean(options.autofocus) });
      });
      // Text typed while an earlier send held the place comes back into the fresh seed, also after navigation.
      if (buffered.trim()) setPending({ kind: "append", text: buffered });
      return true;
    } catch (error) {
      if (disposed || generation !== loadGeneration) return false;
      if (error instanceof NoVerifiedSender) setNoSender(true);
      else setLoadError(error instanceof Error ? error.message : t().loadFailed);
      return false;
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  };

  /** The box's place: the reply draft where one exists, a fresh seed otherwise; never while scheduled or detached. */
  const settle = (options: { autofocus?: boolean } = {}) => {
    if (disposed || detachedId() !== null || scheduled() || justSent() || switching()) return;
    const existing = replyDraft();
    if (existing && !gone.has(existing.id)) return void load({ kind: "draft", id: existing.id }, options);
    const message = sourceMessage();
    if (message) void load({ kind: "seed", intent: mailMode(), message, withText: false }, options);
  };

  // The browser loads the box after hydration; the server renders its placeholder at the same height.
  onMount(() => settle());
  // A colleague's new reply draft replaces an untouched seed; a scheduled send ends and the box fills again.
  createEffect(
    on(
      () => [replyDraft()?.id ?? null, scheduled()?.submissionId ?? null, hold()] as const,
      ([existingId]) => {
        const current = untrack(mount);
        if (untrack(switching) || untrack(detachedId) !== null) return;
        if (!current) return void untrack(() => (loading || loadError() || noSender() ? undefined : settle()));
        if (untrack(scheduled)) return;
        if (current.kind === "seed" && existingId && !gone.has(existingId) && existingId !== untrack(draftId)) {
          // Typing here goes on; its first save meets the occupied place and offers the colleague's draft.
          if (!untrack(controls)?.changed()) settle();
        }
      },
      { defer: true },
    ),
  );

  // Work for the next draft runs once it takes input: append text, send at a time, or put the caret in the text.
  createEffect(() => {
    const action = pending();
    const current = controls();
    if (!action || !current || !current.ready()) return;
    setPending(null);
    untrack(() => {
      if (action.kind === "append") {
        current.appendText(action.text);
        current.focusText();
      } else if (action.kind === "sendAt") current.sendAt(action.at);
      else current.focusText();
    });
  });

  /** Takes what was typed into the seed (and the buffer kept for it); the seed then never becomes a draft. */
  const takeTypedText = (): string | null => {
    const current = controls();
    const mounted = mount();
    if (!current || mounted?.kind !== "seed" || draftId()) return null;
    const text = current.changed() ? current.text().trim() : "";
    current.forgetLocal();
    storeText("pending", "");
    return text || null;
  };

  const openDraft = (id: string) => {
    gone.delete(id);
    // Text typed while the last reply waited to send becomes a copy to restore, never mixed in by itself.
    const typed = takeTypedText();
    if (typed) setMeanwhile(typed);
    batch(() => {
      setDetachedId(null);
      setJustSent(false);
      if (mode() === "note") setMode(mailMode());
    });
    void load({ kind: "draft", id }, { autofocus: true });
  };

  /** Switches between Reply, Reply all, and Forward; the text stays. */
  const switchMailMode = async (next: MailReplyMailMode, focus = true): Promise<void> => {
    const current = mount();
    if (!current || next === mailMode() || switching()) {
      if (focus) setPending({ kind: "focus" });
      return;
    }
    setSwitching(true);
    setSwitchError(null);
    try {
      // A seed whose first save created the draft is that draft now: it switches on the server like any draft.
      if (current.kind === "seed" && !draftId()) {
        const typed = takeTypedText();
        const message = sourceMessage();
        if (!message) return;
        const loaded = await load({ kind: "seed", intent: next, message, withText: Boolean(typed) }, { autofocus: focus });
        if (loaded && typed) setPending({ kind: "append", text: typed });
        return;
      }
      // A mode is a structural edit: save and give back the lease first, then switch on the server and show the result.
      const id = draftId() ?? (current.kind === "draft" ? current.draft.id : null);
      if (!id) return;
      await controls()?.collapse({ preserveDraft: true });
      if (disposed) return;
      const param = { mailboxId: props.mailboxId, draftId: id };
      try {
        const latest = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({ param });
        if (!latest.ok) throw new Error(await readApiError(latest, t().modeSwitchFailed));
        const draft = await latest.json();
        const changed = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].intent.$post({
          param,
          json: { intent: next, expectedRevision: draft.revision },
        });
        if (!changed.ok) throw new Error(await readApiError(changed, t().modeSwitchFailed));
        if (disposed) return;
        await load({ kind: "draft", id, known: await changed.json() }, { autofocus: focus });
      } catch (error) {
        if (disposed) return;
        // The draft comes back as it was, and so does the mode on display; one quiet line names the reason.
        await load({ kind: "draft", id }, { autofocus: focus });
        if (!disposed && mode() !== "note") setMode(mailMode());
        setSwitchError(error instanceof Error ? error.message : t().modeSwitchFailed);
      }
    } finally {
      setSwitching(false);
    }
  };

  const enterNote = () => {
    if (mode() === "note") return;
    // The note keeps the box's height, so nothing below or above moves.
    const composer = frame?.querySelector<HTMLElement>("[data-mail-reply-box='mail']");
    batch(() => {
      setNoteMinHeight(composer?.offsetHeight ?? null);
      setMode("note");
      setNoteError(null);
    });
    // The reply draft stays as it is: saved, its lease free for colleagues while the note is written.
    void controls()?.release();
    queueMicrotask(() => noteField?.focus());
  };

  const chooseMode = (next: MailReplyMode) => {
    if (next === "note") return enterNote();
    const wasNote = mode() === "note";
    setMode(next);
    if (wasNote && next === mailMode()) return void setPending({ kind: "focus" });
    void switchMailMode(next);
  };

  /** Saves the note through the comments API only; then the box returns to the reply, its draft unchanged. */
  const saveNote = async () => {
    // A note is only ever saved from note mode; mail modes never create a comment.
    if (mode() !== "note" || noteSaving()) return;
    const body = noteText().trim();
    if (!body) return;
    setNoteSaving(true);
    setNoteError(null);
    try {
      await props.createNote(body, t().noteSaveFailed);
      if (disposed) return;
      storeText("note", "");
      batch(() => {
        setNoteText("");
        setNoteMinHeight(null);
        setMode(mailMode());
      });
      announce(t().noteSaved);
      setPending({ kind: "focus" });
    } catch (error) {
      if (disposed) return;
      // The browser's own network message is not in the person's language.
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      setNoteError(
        offline
          ? t().noteOffline
          : error instanceof TypeError
            ? t().noteSaveFailed
            : error instanceof Error
              ? error.message
              : t().noteSaveFailed,
      );
    } finally {
      if (!disposed) setNoteSaving(false);
    }
  };

  const updateNote = (value: string) => {
    setNoteText(value);
    storeText("note", value);
  };

  props.register({
    open: (requested, options = {}) => {
      // Without a verified sender, Reply says why and leads an administrator to the setting that fixes it.
      if (requested !== "note" && !props.identities.some((identity) => identity.status === "verified"))
        return props.onExplainSenderUnavailable();
      if (requested === "note") return enterNote();
      const intent = requested === "reply_all" && !props.canReplyAll ? "reply" : requested;
      // A quote goes into the reply as typed text; a forward brings its own forwarded text.
      const quote = intent !== "forward" ? options.quote : undefined;
      batch(() => setMode(intent));
      const current = mount();
      const message = options.message;
      // An untouched seed answers the message the person picked; a draft keeps its own source.
      if (current?.kind === "seed" && !draftId() && message && message.id !== current.seed.sourceMessageId && !controls()?.changed()) {
        void load({ kind: "seed", intent, message, withText: Boolean(quote) }, { autofocus: true }).then((loaded) => {
          if (loaded && quote) setPending({ kind: "append", text: quote });
        });
        return;
      }
      if (intent !== mailMode()) {
        void switchMailMode(intent).then(() => {
          if (quote) setPending({ kind: "append", text: quote });
        });
        return;
      }
      setPending(quote ? { kind: "append", text: quote } : { kind: "focus" });
      if (!current) settle({ autofocus: true });
    },
    openDraft,
  });

  /** Takes the draft back from its window into the box. */
  const bringBack = async () => {
    const id = detachedId();
    if (!id) return;
    await recallDraftWindow(id);
    if (disposed) return;
    openDraft(id);
  };
  // A window closed by itself (sent, discarded, or just closed): the box fills again with the conversation's draft.
  createEffect(
    on(
      detached,
      (now, before) => {
        if (before && !now && untrack(detachedId)) {
          setDetachedId(null);
          if (!untrack(mount)) settle();
        }
      },
      { defer: true },
    ),
  );

  const acknowledge = async () => {
    const id = draftId();
    if (!id) return;
    const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].consolidation.acknowledge.$post({
      param: { mailboxId: props.mailboxId, draftId: id },
    });
    if (!response.ok) return void prompts.error(await readApiError(response, t().acknowledgeFailed));
    setConsolidated(0);
  };

  /** Cancels the scheduled send; the draft comes back into the box, optionally to be scheduled again at a new time. */
  const cancelScheduled = async (then?: { at: string }) => {
    const current = scheduled();
    if (!current || scheduledBusy()) return;
    setScheduledBusy(true);
    try {
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"].cancel.$post({
        param: { mailboxId: props.mailboxId, scheduledSendId: current.submissionId },
        json: { disposition: "draft" },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().cancelScheduledFailed));
      const result = await response.json();
      if (disposed) return;
      if (then) setPending({ kind: "sendAt", at: then.at });
      openDraft(result.draftId);
      void props.onReconcile().catch(() => undefined);
    } catch (error) {
      if (!disposed) void prompts.error(error instanceof Error ? error.message : t().cancelScheduledFailed);
    } finally {
      if (!disposed) setScheduledBusy(false);
    }
  };
  const changeScheduledTime = async () => {
    const at = await chooseScheduledSendTime(props.dateConfig);
    if (at && !disposed) await cancelScheduled({ at });
  };

  const modeLabel = (value: MailReplyMode) =>
    value === "reply" ? t().modeReply : value === "reply_all" ? t().modeReplyAll : value === "forward" ? t().modeForward : t().modeNote;
  const modeIcon = (value: MailReplyMode) =>
    value === "reply"
      ? "ti-arrow-back-up"
      : value === "reply_all"
        ? "ti-arrow-back-up-double"
        : value === "forward"
          ? "ti-arrow-forward-up"
          : "ti-note";
  const modeItems = (): DropdownItem[] => [
    {
      items: (["reply", "reply_all", "forward"] as const)
        .filter((value) => value !== "reply_all" || props.canReplyAll)
        .map((value) => ({
          label: modeLabel(value),
          icon: `ti ${modeIcon(value)}`,
          choice: "radio" as const,
          checked: () => mode() === value,
          disabled: switching(),
          action: () => chooseMode(value),
        })),
    },
    {
      items: [
        {
          label: t().modeNote,
          icon: "ti ti-note",
          choice: "radio" as const,
          checked: () => mode() === "note",
          trailing: <span class="text-xs text-dimmed">{t().modeNoteHint}</span>,
          action: () => chooseMode("note"),
        },
      ],
    },
  ];
  const ModeMenu = () => (
    <Dropdown.Root position="bottom-left" width="17rem" items={modeItems()}>
      <Dropdown.Trigger
        appearance="plain"
        type="button"
        class="mail-reply-box-mode"
        data-mail-reply-mode={mode()}
        aria-label={t().changeMode({ mode: modeLabel(mode()) })}
        disabled={switching()}
      >
        <i class={`ti ${modeIcon(mode())}`} aria-hidden="true" />
        <Show when={mode() === "note"}>
          <span class="mail-reply-box-mode-label">{t().modeNote}</span>
        </Show>
        <i class="ti ti-chevron-down mail-reply-box-mode-chevron" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  const Banner = () => (
    <>
      <Show when={consolidated() > 0}>
        <div class="mail-reply-box-line" role="status" data-mail-reply-consolidated>
          <i class="ti ti-info-circle" aria-hidden="true" />
          <span class="min-w-0 flex-1">{t().consolidated({ count: consolidated() + 1 })}</span>
          <Button variant="ghost" size="xs" type="button" onClick={() => void acknowledge()}>
            {t().understood}
          </Button>
        </div>
      </Show>
      <Show when={switchError()}>
        {(reason) => (
          <div class="mail-reply-box-line" data-tone="danger" role="alert" data-mail-reply-switch-failed>
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              {t().modeSwitchFailed} {reason() === t().modeSwitchFailed ? "" : reason()}
            </span>
            <Button variant="ghost" size="xs" type="button" onClick={() => setSwitchError(null)}>
              {t().understood}
            </Button>
          </div>
        )}
      </Show>
      <Show when={meanwhile()}>
        {(text) => (
          <div class="mail-reply-box-line" role="status" data-mail-reply-meanwhile>
            <i class="ti ti-history" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate" title={text()}>
              {t().meanwhile} „{text()}“
            </span>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              disabled={!controls()?.ready()}
              onClick={() => {
                setPending({ kind: "append", text: text() });
                setMeanwhile(null);
              }}
            >
              {t().restoreChanges}
            </Button>
            <Button variant="ghost" size="xs" type="button" onClick={() => setMeanwhile(null)}>
              {t().discardChanges}
            </Button>
          </div>
        )}
      </Show>
    </>
  );

  const host = (current: Mount): MailComposerHost => ({
    fresh: false,
    fullscreen: () => false,
    toggleFullscreen: () => undefined,
    register: (next) => setControls(next),
    messageLabel: props.messageLabel,
    leave: (outcome) => {
      if (current.key !== untrack(mount)?.key) return;
      setControls(null);
      const id = untrack(draftId);
      if (outcome === "moved") {
        batch(() => {
          setDetachedId(id);
          setMount(null);
        });
        return;
      }
      // A mode switch saves and releases on purpose; the switch mounts the result itself.
      if (outcome === "closed" && untrack(switching)) return;
      if (id && (outcome === "sent" || outcome === "discarded")) gone.add(id);
      if (outcome === "discarded") storeText("pending", "");
      batch(() => {
        setMount(null);
        setDraftId(null);
        setConsolidated(0);
        if (outcome === "sent") setJustSent(true);
      });
      // The sent message or the removed draft shows from the server's state; the empty box follows it.
      void props
        .onReconcile()
        .catch(() => undefined)
        .finally(() => {
          if (disposed) return;
          setJustSent(false);
          settle({ autofocus: outcome !== "closed" });
        });
    },
    openDraft,
    box: {
      modeMenu: () => <ModeMenu />,
      banner: () => <Banner />,
      suspended: () => mode() === "note",
      holdCreate: hold,
      autofocus: current.autofocus,
      materialized: (draft) => {
        // The buffered text is in the draft now. This also runs when the draft is created on the way out.
        storeText("pending", "");
        if (!disposed) setDraftId(draft.id);
      },
      buffer: (text) => storeText("pending", text),
      detach: (id) => {
        if (current.key !== untrack(mount)?.key) return;
        batch(() => {
          setControls(null);
          setMount(null);
          setDetachedId(id);
        });
        openDraftWindow(id, { mailboxId: props.mailboxId });
      },
    },
  });

  const audience = () => (props.customerName ? t().noteAudience({ name: props.customerName }) : t().noteAudienceUnknown);
  // Mod+Enter in the note saves the note. It never reaches a send: the draft is inert, and its Send refuses while
  // suspended.
  const noteKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void saveNote();
  };

  return (
    <div ref={frame} class="mail-reply-box-frame" data-mail-reply-box-frame data-mode={mode()}>
      <Show when={scheduled() && detachedId() === null}>
        <section class="mail-reply-box mail-reply-box-state" data-mail-reply-box="scheduled" aria-label={t().boxLabel}>
          <i class="ti ti-clock" aria-hidden="true" />
          <span class="min-w-0 flex-1" role="status">
            {t().scheduledFor({ value: dates.formatDateTime(scheduled()!.scheduledAt, props.dateConfig) })}
          </span>
          <Button variant="ghost" size="sm" type="button" disabled={scheduledBusy()} onClick={() => void changeScheduledTime()}>
            {t().changeTime}
          </Button>
          <Button variant="secondary" size="sm" type="button" loading={scheduledBusy()} onClick={() => void cancelScheduled()}>
            {t().cancelAndEdit}
          </Button>
        </section>
      </Show>
      <Show when={detachedId() !== null && !scheduled()}>
        <section class="mail-reply-box mail-reply-box-state" data-mail-reply-box="detached" aria-label={t().boxLabel}>
          <i class="ti ti-app-window" aria-hidden="true" />
          <span class="min-w-0 flex-1" role="status">
            {t().detached}
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={() => void bringBack()}>
            {t().bringBack}
          </Button>
        </section>
      </Show>
      <Show when={!scheduled() && detachedId() === null}>
        <Show
          when={mount()}
          keyed
          fallback={
            <Show when={mode() !== "note"}>
              <section
                class="mail-reply-box mail-reply-box-pending"
                data-mail-reply-box="pending"
                aria-label={t().boxLabel}
                aria-busy={!loadError() && !noSender()}
              >
                <Show
                  when={loadError() || noSender()}
                  fallback={
                    <div class="mail-reply-box-skeleton" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  }
                >
                  <Placeholder
                    state="error"
                    variant="compact"
                    align="left"
                    title={noSender() ? t().noSender : t().loadFailed}
                    description={loadError() ?? undefined}
                    onRetry={noSender() ? props.onExplainSenderUnavailable : () => settle()}
                  />
                </Show>
              </section>
            </Show>
          }
        >
          {(current) => (
            <current.parts.Composer
              host={host(current)}
              mailboxId={props.mailboxId}
              mailboxRecipientSuggestions={props.mailboxRecipientSuggestions}
              currentActor={{ kind: "user", id: props.currentUserId }}
              identities={props.identities}
              signatures={current.parts.signatures}
              {...(current.kind === "draft"
                ? { initialDraft: current.draft, unfinishedUploads: current.uploads }
                : { initialSeed: current.seed })}
              initialPanes={createDefaultMailComposerPanesLayout()}
              returnHref={props.returnHref}
              dateConfig={props.dateConfig}
              canShareAttachments={props.canAdmin}
              canManageMailbox={props.canAdmin}
              currentUserEmail={props.currentUserEmail}
              calendarIntegrationAvailable={props.calendarIntegrationAvailable}
              liveDictation={props.liveDictation}
            />
          )}
        </Show>
        <Show when={mode() === "note"}>
          <section
            class="mail-reply-box mail-reply-box-note"
            data-mail-reply-box="note"
            data-note-failed={noteError() ? "" : undefined}
            aria-label={t().modeNote}
            style={noteMinHeight() ? { "min-height": `${noteMinHeight()}px` } : undefined}
            onKeyDown={noteKeyDown}
          >
            <header class="mail-reply-box-head mail-reply-box-note-head">
              <ModeMenu />
              <span class="mail-reply-box-note-audience">{audience()}</span>
              <span class="mail-note-badge mail-reply-box-note-badge">
                <i class="ti ti-lock" aria-hidden="true" />
                {t().noteBadge}
              </span>
            </header>
            <TextInput
              multiline
              lines={3}
              class="mail-reply-box-note-text"
              ref={(element: HTMLInputElement | HTMLTextAreaElement) => {
                if (element.tagName === "TEXTAREA") noteField = element as HTMLTextAreaElement;
              }}
              aria-label={t().modeNote}
              placeholder={t().notePlaceholder}
              maxLength={50_000}
              value={noteText}
              onValueChange={updateNote}
              disabled={noteSaving()}
            />
            <div class="mail-reply-box-space" aria-hidden="true" onClick={() => noteField?.focus()} />
            <Show
              when={noteError()}
              fallback={
                <footer class="mail-reply-box-foot mail-reply-box-note-foot">
                  <Button
                    type="button"
                    size="sm"
                    class="mail-reply-box-note-save"
                    data-mail-note-save
                    loading={noteSaving()}
                    disabled={!noteText().trim()}
                    onClick={() => void saveNote()}
                  >
                    <i class="ti ti-lock" aria-hidden="true" />
                    {t().noteSave}
                  </Button>
                  <span class="mail-reply-box-status" role="status">
                    {t().noteDraftKept}
                  </span>
                </footer>
              }
            >
              {(reason) => (
                <footer class="mail-reply-box-foot mail-reply-box-note-foot" data-tone="danger" role="alert" data-mail-note-failed>
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  <span class="mail-reply-box-failure">
                    <strong>{t().noteNotSavedLead}</strong> {reason()} {t().noteTextStays}
                  </span>
                  <Button type="button" size="sm" data-mail-note-retry loading={noteSaving()} onClick={() => void saveNote()}>
                    {t().noteRetry}
                  </Button>
                </footer>
              )}
            </Show>
          </section>
        </Show>
      </Show>
    </div>
  );
}
