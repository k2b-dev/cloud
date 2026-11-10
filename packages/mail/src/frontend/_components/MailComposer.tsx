import { consumeCommandLink, registerCommandHandler, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { chooseFiles } from "@k2b/cloud/browser/files";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { navigateTo, onBeforeLeave } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CheckboxCard,
  type Completion,
  Dropdown,
  type DropdownItem,
  FileDropTarget,
  formatShortcut,
  IconButton,
  isPanesItemVisible,
  NoticeCard,
  type PanesLayout,
  Placeholder,
  prompts,
  ScrollArea,
  Select,
  SplitButton,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import type { TextEditorController } from "@k2b/ui/text-editor";
import { type Accessor, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { MailDraftCalendarInputSchema, mailCommandMessages } from "../../commands";
import {
  type ComposePreview,
  type ComposeSafetyApproval,
  DRAFT_LEASE_ERROR_CODES,
  type DraftEditableContent,
  type DraftEditableContentInput,
  type DraftIntent,
  type DraftRecoveryCopy,
  type DraftSendReview,
  MAX_DRAFT_ATTACHMENT_BYTES,
  type MailCommand,
  type MailDraft,
  type MailDraftSeed,
  type MailPriority,
  type SenderIdentity,
} from "../../contracts";
import { mailSharedDraftMessages } from "../../lib/draft-document-client";
import { openMailUserDraftStorage } from "../../lib/mail-user-draft-storage";
import { readApiError, readApiFailure } from "./api-response";
import MailComposerAttachments from "./MailComposerAttachments";
import { openMailComposerCalendarDialog } from "./MailComposerCalendarDialog";
import MailComposerEditor from "./MailComposerEditor";
import MailComposerHistory from "./MailComposerHistory";
import MailComposerLifecycleNotice from "./MailComposerLifecycleNotice";
import MailComposerSignature from "./MailComposerSignature";
import { mailDraftCollaborationCopy, openMailDraftCollaborationDialog } from "./MailDraftCollaborationDialog";
import MailInlineSignature from "./MailInlineSignature";
import MailRecipientInput, { type MailRecipientField } from "./MailRecipientInput";
import { chooseScheduledSendTime } from "./MailScheduleDialog";
import MailSenderUnavailableNotice from "./MailSenderUnavailableNotice";
import { readMailUserPreferences, writeMailComposerPanes } from "./MailSettingsStore";
import type { MailTextEditorActions } from "./MailTextEditor";
import { mailConversationHref, mailDraftHref, mailDraftSeedHref } from "./mail-compose-route";
import { createMailComposerAttachmentManager, type UnfinishedDraftUpload } from "./mail-composer-attachment-manager";
import { focusMailComposerEditorAtStart } from "./mail-composer-editor-focus";
import { mailComposerMessages } from "./mail-composer-messages";
import { reconcileMailComposerPanes } from "./mail-composer-panes";
import { defaultSignatureTemplateId, type MailComposerSignatures } from "./mail-composer-signature";
import { createMailComposerTransition } from "./mail-composer-transition";
import { useMailContactDirectory } from "./mail-contact-directory-context";
import { confirmSharedDraftRecipients } from "./mail-draft-document-confirmation";
import { mailDraftPeers } from "./mail-draft-document-presence";
import { mailDraftJournalKey, serializeMailDraftContent } from "./mail-draft-journal";
import { removeMailDraftSeed } from "./mail-draft-seed-store";
import { createMailDraftSession } from "./mail-draft-session";
import { formatMailRecipients, parseMailRecipients } from "./mail-recipient";
import { writeMailSenderPreference } from "./mail-sender-preference";

class ComposeSafetyCancelled extends Error {}
class ComposeSafetyAttachmentRequested extends Error {}
/** A recipient field still holds text that is no address; the field itself marks it and holds the focus. */
class ComposeRecipientPending extends Error {}

const intentIcon = (intent: DraftIntent): string =>
  intent === "reply"
    ? "ti-arrow-back-up"
    : intent === "reply_all"
      ? "ti-arrow-back-up-double"
      : intent === "forward"
        ? "ti-arrow-forward-up"
        : "ti-send";

/** What the host may start through the composer's own safe paths. */
export type MailInlineDraftControls = {
  collapse: () => Promise<void>;
  /** The same Send as the draft's own button, with every review and guard. */
  send: () => void;
  /** Moves the caret back into the text, at its end. */
  focusText: () => void;
};

/**
 * A conversation that shows the draft in place instead of a compose page. The composer keeps every save, lease, and
 * send rule; it only asks the host where to go instead of navigating.
 */
export type MailComposerHost = {
  /** The draft left this place: saved and released, discarded, sent, or moved to its own window. */
  leave: (outcome: "closed" | "discarded" | "sent" | "moved") => void;
  /** Another draft takes this place, such as a saved copy of unsaved input or the rest of a shared draft. */
  openDraft: (draftId: string) => void;
  /** True when this click created the draft: collapsing it unchanged discards it again. */
  fresh: boolean;
  fullscreen: Accessor<boolean>;
  toggleFullscreen: () => void;
  /** The composer hands the host its safe close, so Esc and the host's own controls take the same path. */
  register: (controls: MailInlineDraftControls) => void;
  /** Who wrote a message of the conversation and when, for the quote line ("Marlene Hofbauer, today 09:12"). */
  messageLabel: (messageId: string) => string | null;
  /** A new message tells the list its subject and recipients while someone types them. */
  summary?: (value: { subject: string; to: string[] }) => void;
};

export default function MailComposer(props: {
  /** Shows the draft inside its conversation; without a host the composer is a page of its own. */
  host?: MailComposerHost;
  mailboxId: string;
  mailboxRecipientSuggestions?: boolean;
  currentActor: { kind: "user" | "service_account"; id: string };
  identities: SenderIdentity[];
  signatures: MailComposerSignatures;
  initialDraft?: MailDraft;
  initialSeed?: MailDraftSeed;
  unfinishedUploads?: UnfinishedDraftUpload[];
  initialPanes: PanesLayout;
  popout?: boolean;
  returnHref: string;
  dateConfig: DateContext;
  canShareAttachments?: boolean;
  calendarIntegrationAvailable?: boolean;
  /** Live dictation is set up and allowed for this person; the editor toolbar then shows Dictate. */
  liveDictation?: boolean;
  /** Lets the composer open the mailbox's sender settings when no verified sender can send. */
  canManageMailbox?: boolean;
  currentUserEmail?: string | null;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const contactDirectory = useMailContactDirectory();
  const intentLabel = (intent: DraftIntent): string =>
    intent === "reply" ? t().reply : intent === "reply_all" ? t().replyAll : intent === "forward" ? t().forward : t().send;
  const initial = props.initialDraft ?? props.initialSeed;
  if (!initial) throw new Error("MailComposer requires a draft or compose seed");
  const initialContent = props.initialDraft
    ? {
        senderIdentityId: props.initialDraft.senderIdentityId,
        signatureTemplateId: props.initialDraft.signatureTemplateId,
        quoteSource: props.initialDraft.quoteSource,
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
  let initialEditorFocusApplied = false;
  const verifiedIdentities = () => props.identities.filter((identity) => identity.status === "verified");
  const preferences = readMailUserPreferences(props.mailboxId);
  const [identityId, setIdentityId] = createSignal(initialContent.senderIdentityId);
  const [quoteSource, setQuoteSource] = createSignal(initialContent.quoteSource ?? null);
  const [signatureTemplateId, setSignatureTemplateId] = createSignal(initialContent.signatureTemplateId ?? null);
  // Once shown, the button stays, including for an unavailable shared signature, so "No signature" never moves it away.
  // A signature that arrives later (shared input, a recovered copy) shows it too, so the person can remove it.
  const [signatureChoiceSeen, setSignatureChoiceSeen] = createSignal(Boolean(initialContent.signatureTemplateId));
  createEffect(() => {
    if (signatureTemplateId()) setSignatureChoiceSeen(true);
  });
  const signatureChoiceVisible = () => props.signatures.templates.length > 0 || signatureChoiceSeen();
  const senderDefaultSignatureId = () => defaultSignatureTemplateId(props.signatures, props.identities, identityId());
  const selectedIdentity = () => verifiedIdentities().find((identity) => identity.id === identityId()) ?? null;
  const identityMenuItems = createMemo<DropdownItem[]>(() =>
    verifiedIdentities().map((identity) => ({
      icon: identity.id === identityId() ? "ti ti-check" : "ti ti-user",
      label: `${identity.label} · ${identity.fromAddress}`,
      action: () => {
        if (identity.id !== identityId()) {
          setIdentityId(identity.id);
          setSignatureTemplateId(defaultSignatureTemplateId(props.signatures, props.identities, identity.id));
        }
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
    if (priority() === "high") options.push(t().highPriority);
    if (priority() === "low") options.push(t().lowPriority);
    if (requestDeliveryReceipt()) options.push(t().deliveryReceipt);
    if (requestReadReceipt()) options.push(t().readReceipt);
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
  let seedStorage: Storage | undefined;
  onMount(() => {
    if (props.currentActor.kind === "user") {
      try {
        seedStorage = openMailUserDraftStorage(localStorage, props.currentActor.id);
      } catch {
        /* Cleanup is best effort. */
      }
    }
  });
  const clearInitialSeed = () => {
    if (!props.initialSeed || !seedStorage) return;
    try {
      removeMailDraftSeed(seedStorage, props.mailboxId, props.initialSeed.id);
      seedStorage.removeItem(mailDraftJournalKey(props.mailboxId, props.initialSeed.id));
    } catch {
      // Expired local seed cleanup must never block leaving the composer.
    }
  };

  const content = (): DraftEditableContent => ({
    senderIdentityId: identityId(),
    signatureTemplateId: signatureTemplateId(),
    quoteSource: quoteSource(),
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

  const applyDraftContent = (value: DraftEditableContent, source?: "shared") => {
    setIdentityId(value.senderIdentityId);
    setSignatureTemplateId(value.signatureTemplateId ?? null);
    setQuoteSource(value.quoteSource);
    const updateRecipients = (current: string[], next: string[], set: (value: string[]) => void) => {
      if (current.length !== next.length || current.some((value, index) => value !== next[index])) set(next);
    };
    updateRecipients(to(), formatMailRecipients(value.to), setTo);
    updateRecipients(cc(), formatMailRecipients(value.cc), setCc);
    updateRecipients(bcc(), formatMailRecipients(value.bcc), setBcc);
    setShowCc((current) => (source === "shared" && current) || Boolean(value.cc.length || value.bcc.length));
    setSubject(value.subject);
    setBody(value.body);
    setFormat(value.format);
    setPriority(value.priority);
    setRequestDeliveryReceipt(value.requestDeliveryReceipt);
    setRequestReadReceipt(value.requestReadReceipt);
  };
  const draftSession = createMailDraftSession({
    mailboxId: props.mailboxId,
    currentActor: props.currentActor,
    initialDraft: props.initialDraft,
    initialSeed: props.initialSeed,
    hasVerifiedIdentity: () => verifiedIdentities().length > 0,
    content,
    applyDraftContent,
    isDisposed: () => disposed,
    onRecovered: () => toast(t().unsavedChangesRestored, { title: t().draftRecovered }),
    // The draft already left the screen: the error says so, and opening the draft again brings back what is saved.
    onClosedUnsaved: () => toast.error(t().closedUnsaved, { title: t().draftCouldNotBeSaved }),
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
    locale,
  });
  const {
    draft,
    setDraft,
    shared,
    sharedState,
    isShared,
    lease,
    materializedLeasePending,
    authenticationRequired,
    prepareSignIn,
    leaseConflict,
    lifecycleTransition,
    status,
    saveStatus,
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
  const leaveTo = (href: string) => {
    draftSession.allowNavigation();
    navigateTo(href);
  };
  /** A popout that sent, discarded, or saved its draft closes; a browser that keeps it open shows why it stays. */
  const [popoutDone, setPopoutDone] = createSignal<Exclude<Parameters<MailComposerHost["leave"]>[0], "moved"> | null>(null);
  const closePopout = (outcome: Exclude<Parameters<MailComposerHost["leave"]>[0], "moved">) => {
    draftSession.allowNavigation();
    window.close();
    // Only a window that a script opened may close itself; any other one stays and says so.
    setTimeout(() => {
      if (!window.closed && !disposed) setPopoutDone(outcome);
    }, 100);
  };
  /** Back where the person came from: the conversation that holds the draft, or the compose page's return place. */
  const leaveBack = (outcome: Parameters<MailComposerHost["leave"]>[0]) => {
    if (!props.host && props.popout && outcome !== "moved") return closePopout(outcome);
    if (!props.host) return leaveTo(props.returnHref);
    draftSession.allowNavigation();
    props.host.leave(outcome);
  };
  const openOtherDraft = (draftId: string) =>
    props.host
      ? props.host.openDraft(draftId)
      : leaveTo(mailDraftHref(props.mailboxId, draftId, props.returnHref, { popout: props.popout }));
  const sharedT = () => mailSharedDraftMessages.resolve([locale()]).t;
  onBeforeLeave((event) => {
    const current = sharedState();
    if (!current || (!current.rejectedEdit && !current.structuring && (!current.dirty || (current.remembering && current.locallySaved))))
      return;
    event.preventDefault();
    void event.restored.then(() =>
      prompts.error(
        current.rejectedEdit
          ? sharedT().bodyEditFailed
          : current.structuring
            ? sharedT().tablePending
            : current.remembering
              ? sharedT().storageFailed
              : sharedT().notRemembered,
      ),
    );
  });
  const [tableNeedsCheck, setTableNeedsCheck] = createSignal(false);
  const sharedCanSend = () =>
    !isShared() ||
    Boolean(
      sharedState()?.connected &&
        sharedState()?.ready &&
        !sharedState()?.terminal &&
        !sharedState()?.structuring &&
        !sharedState()?.rejectedEdit,
    );
  const saveState = () => {
    if (status() === "error" || status() === "readonly") return "";
    if (status() === "saving" || status() === "preparing") return t().savingDraft;
    return saveStatus() === "saved" ? t().draftSaved : saveStatus() === "local" ? t().draftSavedLocally : t().draftSavePending;
  };
  const conversationId = () => draft()?.conversationId ?? initial.conversationId;
  const composeWithAi = mutations.create<void, void>({
    mutation: async () => {
      const currentDraft = await persist();
      if (!currentDraft) throw new Error(statusMessage() || t().draftCouldNotBeSaved);
      // The Assistant handoff and its skill parser load only when someone uses it.
      const assistant = await importOnDemand(() => import("./mail-assistant-launch"));
      if (!assistant) return;
      const launch = await assistant.launchMailDraftAssistant({
        contactResolve: contactDirectory.resolve,
        mailboxId: props.mailboxId,
        returnHref: props.returnHref,
        draft: currentDraft,
      });
      leaveTo(launch.href);
    },
  });
  const saveLifecycleCopy = mutations.create<MailDraft, void>({
    mutation: async () => {
      if (isShared()) {
        const recovered = await shared()?.recover();
        if (recovered?.status === "recovered") return recovered.draft;
        throw new Error(sharedT().restUnchanged);
      }
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
      if (!response.ok) throw new Error(await readApiError(response, t().saveAsNewFailed));
      return await response.json();
    },
    onSuccess: (created) => {
      const current = draft();
      if (current) draftSession.forgetJournal(current.id, { closed: Boolean(lifecycleTransition()) });
      openOtherDraft(created.id);
    },
    onError: (error) => prompts.error(error.message),
  });
  const recoverSaveError = async () => {
    if (!draftSession.revisionConflict()) return void (await persist());
    if (draft()?.conversationId) return void (await restoreRecoveryCopy());
    const reservation = composerTransition.reserve("recovery");
    if (!reservation) return;
    try {
      await saveLifecycleCopy.mutate();
    } finally {
      composerTransition.release(reservation);
    }
  };
  const copyLifecycleText = async () => {
    try {
      await navigator.clipboard.writeText(body());
      toast.success(t().unsavedTextCopied);
    } catch {
      await prompts.error(t().copyTextFailed);
    }
  };
  const openLifecycleMessage = () => {
    const current = lifecycleTransition()?.draft;
    if (!current?.conversationId) return;
    // Inline, the message already stands in the conversation below.
    if (props.host) return leaveBack("closed");
    const target = new URL(props.returnHref, window.location.origin);
    target.searchParams.set("conversation", current.conversationId);
    leaveTo(`${target.pathname}${target.search}${target.hash}`);
  };
  const currentComposerPanes = createMemo(() => reconcileMailComposerPanes(composerPanes(), format(), Boolean(conversationId())));
  // Inline, "Preview" is one visible switch in the draft's tools; the page keeps its panes.
  const [inlinePreview, setInlinePreview] = createSignal(false);
  const [inlineFormatting, setInlineFormatting] = createSignal(false);
  const previewVisible = () => (props.host ? inlinePreview() : isPanesItemVisible(currentComposerPanes(), "preview"));
  type PreviewInput = { draft: DraftEditableContentInput; conversationId: string | null; sourceMessageId: string | null };
  const initialPreviewInput: PreviewInput = {
    draft: content(),
    conversationId: conversationId(),
    sourceMessageId: initial.sourceMessageId,
  };
  const [previewSource, setPreviewSource] = createSignal(JSON.stringify(initialPreviewInput));
  const previewQuery = query.create<string, ComposePreview>({
    source: previewSource,
    enabled: () => format() === "markdown" && previewVisible() && Boolean(identityId()),
    load: async (serialized, { abortSignal }) => {
      const input = JSON.parse(serialized) as PreviewInput;
      const response = await apiClient.mailboxes[":mailboxId"]["compose-preview"]
        .$post(
          {
            param: { mailboxId: props.mailboxId },
            json: input,
          },
          { init: { signal: abortSignal } },
        )
        .catch((error: unknown) => {
          // The browser's own network message is not in the reader's language.
          if (abortSignal.aborted) throw error;
          throw new Error(t().previewFailed);
        });
      if (!response.ok) throw new Error(await readApiError(response, t().previewFailed));
      return await response.json();
    },
  });
  const previewDebounce = timed.debounce((serialized: string) => setPreviewSource(serialized), 150);
  const stopPreview = () => previewDebounce.cancel();
  const preview = () => previewQuery.data() ?? null;
  // Each new request clears the query's error; keeping it until a preview succeeds stops typing from flickering
  // between the error and the last good preview.
  const [previewError, setPreviewError] = createSignal<string>();
  createEffect(() => {
    const error = previewQuery.error();
    if (error) setPreviewError(error.message);
  });
  createEffect(on(previewQuery.data, () => setPreviewError(undefined), { defer: true }));
  const canEditDraft = createMemo(
    () =>
      verifiedIdentities().length > 0 &&
      status() !== "preparing" &&
      status() !== "readonly" &&
      (isShared() ? Boolean(shared() && !sharedState()?.terminal) : Boolean(lease()) || !draft() || materializedLeasePending()),
  );
  const editable = createMemo(() => canEditDraft() && composerTransition.active() === null);
  /**
   * A short pause, not a read-only draft: the draft opens, sends, or waits for a dialog. Text and fields keep the
   * caret, the focus, a phone keyboard, and their toolbar; only input waits.
   */
  const paused = createMemo(
    () => !editable() && verifiedIdentities().length > 0 && (canEditDraft() || (status() === "preparing" && !sharedState()?.terminal)),
  );
  /** The draft cannot be edited here at all: read-only, without a sender, or ended. */
  const fieldsDisabled = () => !editable() && !paused();
  let editorController: TextEditorController | undefined;
  let editorActions: MailTextEditorActions | undefined;
  /** A click into the draft's empty room below the text puts the caret at the end of the text. */
  const focusEditorAtEnd = () => {
    const view = editorController?.view;
    if (!view || !editable()) return;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
  };
  const [readyEditor, setReadyEditor] = createSignal<TextEditorController>();
  const editorReady = (element: TextEditorController, actions: MailTextEditorActions) => {
    editorController = element;
    editorActions = actions;
    setReadyEditor(element);
  };
  // What had the focus when the draft appeared, usually the Reply or Compose button that opened it.
  const focusAtOpen = typeof document === "undefined" ? null : document.activeElement;
  // A new draft, and a draft someone opened inside its conversation, start with the caret in the text once the
  // editor is ready AND the draft takes input; an opening lease can arrive after the editor.
  createEffect(() => {
    const element = readyEditor();
    if (!element || initialEditorFocusApplied || !editable() || (!props.initialSeed && !props.host)) return;
    initialEditorFocusApplied = true;
    queueMicrotask(() => {
      if (disposed || !element.view.dom.isConnected) return;
      // A place the person chose meanwhile keeps the focus.
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusAtOpen && active.isConnected) return;
      // A new message inside the flow starts where it begins: with its recipients.
      const recipients =
        props.host && composerIntent() === "new" && to().length === 0
          ? surface()?.querySelector<HTMLInputElement>(".mail-inline-draft-recipients input")
          : null;
      if (recipients) recipients.focus();
      else focusMailComposerEditorAtStart(element);
    });
  });
  const attachments = createMailComposerAttachmentManager({
    mailboxId: props.mailboxId,
    draft,
    initialAttachments: () => props.initialSeed?.attachments ?? [],
    unfinishedUploads: props.unfinishedUploads ?? [],
    setDraft: draftSession.acceptMutationDraft,
    editable,
    persist,
    serializeDraftMutation,
    transition: composerTransition,
    format,
    insertText: (text) => {
      if (editorActions) editorActions.appendText(text);
      else setBody((current) => `${current}${current.endsWith("\n") || !current ? "" : "\n\n"}${text}`);
    },
    isDisposed: () => disposed,
    locale,
  });
  const uploads = attachments.uploads;
  /** Uploads this page is streaming; one an earlier session left unfinished only blocks sending. */
  const uploadsInProgress = () => uploads().some((upload) => upload.file !== null);
  /** From this device or from a Cloud app; either way the files take the same upload path, limits, and progress. */
  const chooseAttachments = async () => {
    const current = content();
    const recipients = [...current.to, ...current.cc, ...current.bcc].map((recipient) => ({ ...recipient }));
    const files = await chooseFiles({
      multiple: true,
      maxTotalBytes: MAX_DRAFT_ATTACHMENT_BYTES,
      context: async (signal) => {
        try {
          const module = await importOnDemand(() => import("./mail-attachment-context"));
          signal.throwIfAborted();
          if (!module) throw new Error(t().attachmentContextFailed);
          return await module.resolveAttachmentContext({ directory: contactDirectory.resolve, recipients, signal });
        } catch {
          signal.throwIfAborted();
          throw new Error(t().attachmentContextFailed);
        }
      },
      ...(recipients.length > 0 ? { noMatchingFiles: t().noMatchingAttachments } : {}),
    });
    if (files.length > 0 && editable() && !disposed) void attachments.addFiles(files);
  };
  const [surface, setSurface] = createSignal<HTMLElement>();
  /** Ctrl+Enter (⌘+Enter on Apple) sends from every field of the draft, with the same checks as the Send button. */
  const sendShortcutLabel = () => formatShortcut("mod+enter", { locale: locale() }).label;
  createEffect(() => {
    const element = surface();
    if (!element) return;
    const sendOnShortcut = (event: KeyboardEvent) => {
      // A composing IME owns Enter; Safari reports the key that ends a composition as keyCode 229.
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      // A held key repeats; one press sends once.
      if (!event.repeat) void sendDraft({});
    };
    // Capture runs before the editor's own Mod-Enter binding and before a field's Enter handling.
    element.addEventListener("keydown", sendOnShortcut, true);
    onCleanup(() => element.removeEventListener("keydown", sendOnShortcut, true));
  });

  const addCalendarInvitation = async () => {
    if (!editable() || !props.calendarIntegrationAvailable)
      throw new Error(statusMessage() || mailCommandMessages.resolve([locale()]).t.calendarUnavailable);
    const reservation = composerTransition.reserve("calendar");
    if (!reservation) return;
    try {
      const currentDraft = await persist();
      if (!currentDraft) throw new Error(statusMessage());
      if (disposed) return;
      const updated = await openMailComposerCalendarDialog({
        mailboxId: props.mailboxId,
        draftId: currentDraft.id,
        recipientCount: parseMailRecipients(to()).length + parseMailRecipients(cc()).length,
        dateConfig: props.dateConfig,
      });
      if (updated && !disposed) {
        draftSession.acceptMutationDraft(updated);
        toast(t().invitationAddedDescription, { title: t().invitationAdded });
      }
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t().invitationFailed);
    } finally {
      composerTransition.release(reservation);
    }
  };

  createEffect(() => {
    if (!editable() || !props.calendarIntegrationAvailable) return;
    const copy = mailCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        id: "mail.draft.calendar",
        scope: "selection",
        title: copy.calendarTitle,
        description: copy.calendarDescription,
        icon: "ti ti-calendar-plus",
        action: addCalendarInvitation,
      }),
    );
  });
  onMount(() => {
    onCleanup(
      registerCommandHandler(
        "mail.draft.calendar",
        MailDraftCalendarInputSchema,
        async () => {
          await addCalendarInvitation();
        },
        (input) => input.mailboxId === props.mailboxId && input.draftId === draft()?.id,
      ),
    );
  });
  let calendarLinkConsumed = false;
  createEffect(() => {
    // Wait for the existing draft lease; never bypass a conflict or open a second draft.
    if (calendarLinkConsumed || !editable()) return;
    calendarLinkConsumed = true;
    void consumeCommandLink();
  });

  const updateComposerPanes = (value: PanesLayout) => {
    setComposerPanes(value);
    if (panePersistenceTimer) clearTimeout(panePersistenceTimer);
    panePersistenceTimer = setTimeout(() => {
      setComposerPanes(writeMailComposerPanes(value));
      panePersistenceTimer = null;
    }, 150);
  };

  createEffect(() => {
    // The draft inside a conversation has no panes; it must not overwrite the compose page's stored layout.
    if (props.host) return;
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
      if (!response.ok) throw new Error(await readApiError(response, t().recoveryCopiesFailed));
      const copies: DraftRecoveryCopy[] = await response.json();
      if (disposed || recoveryController !== controller) return;
      const unresolved = copies.filter((copy) => !copy.restoredAt);
      const localCopies = draftSession.localRecoveryCopies();
      const canKeepCurrentInput = draftSession.revisionConflict() && !isShared();
      if (unresolved.length === 0 && localCopies.length === 0 && !canKeepCurrentInput) {
        setDraft({ ...currentDraft, recoveryCopyCount: 0 });
        return void toast(t().noRecoveryCopies, { title: t().draftCurrent });
      }
      const labels = new Map(
        unresolved.map((copy, index) => {
          const preview = copy.content.body.trim().replaceAll(/\s+/g, " ").slice(0, 80) || t().emptyMessage;
          return [
            copy.id,
            t().recoveryCopyOption({
              index: index + 1,
              date: dates.formatDateTimeRelative(copy.createdAt, props.dateConfig),
              actor: copy.createdBy.kind === "user" ? t().user : t().serviceAccount,
              preview,
            }),
          ];
        }),
      );
      const values = await prompts.form({
        title: t().restoreChanges,
        fields: {
          recoveryCopyId: {
            type: "select",
            label: t().recoveryCopy,
            options: [
              ...(canKeepCurrentInput ? [{ id: "current-input", label: t().keepCurrentInput }] : []),
              ...unresolved.map((copy) => ({ id: copy.id, label: labels.get(copy.id) ?? copy.id })),
              ...localCopies.map((copy, index) => ({
                id: copy.id,
                label: t().localRecoveryCopyOption({
                  index: index + 1,
                  preview: copy.content.body.replaceAll(/\s+/g, " ").slice(0, 80) || t().emptyMessage,
                }),
              })),
            ],
            default: unresolved[0]?.id ?? (canKeepCurrentInput ? "current-input" : localCopies[0]?.id),
            required: true,
          },
        },
        confirmText: t().restoreCopy,
      });
      if (!values || disposed || recoveryController !== controller) return;
      if (values.recoveryCopyId === "current-input" && canKeepCurrentInput) {
        if (!draftSession.restoreCurrentInput()) return void (await prompts.error(t().localMessageFailed));
        if (!(await persist())) throw new Error(statusMessage() || t().draftSaveFailed);
        return void toast.success(t().changesRestored);
      }
      if (localCopies.some((copy) => copy.id === values.recoveryCopyId)) {
        if (!draftSession.restoreLocalRecoveryCopy(values.recoveryCopyId)) await prompts.error(t().recoveryCopyUnavailable);
        return;
      }
      const selected = unresolved.find((copy) => copy.id === values.recoveryCopyId);
      if (!selected) return void (await prompts.error(t().recoveryCopyUnavailable));
      if (isShared() || !draftSession.revisionConflict()) {
        const saved = await persist();
        if (!saved && !draftSession.revisionConflict()) throw new Error(statusMessage() || t().draftSaveFailed);
      }
      // A restore and an autosave must accept their returned revisions in the
      // same queue; the recovery transition already prevents new input.
      await serializeDraftMutation(async () => {
        if (disposed || recoveryController !== controller || controller.signal.aborted) return;
        const currentLease = lease();
        if (!canEditDraft() || (!isShared() && !currentLease)) throw new Error(t().draftNotEditable);
        if (!isShared()) draftSession.keepCurrentRecoveryCopy();
        const restore = (leaseToken?: string) =>
          apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["recovery-copies"][":recoveryCopyId"].restore.$post(
            {
              param: {
                mailboxId: props.mailboxId,
                draftId: currentDraft.id,
                recoveryCopyId: selected.id,
              },
              json: { expectedRevision: draft()?.revision ?? currentDraft.revision, leaseToken },
            },
            { init: { signal: controller.signal } },
          );
        let restoreResponse = await restore(currentLease?.token);
        if (restoreResponse.status === 409) {
          const body: unknown = await restoreResponse
            .clone()
            .json()
            .catch(() => null);
          if (typeof body === "object" && body !== null && "code" in body && body.code === DRAFT_LEASE_ERROR_CODES.NOT_OWNED) {
            const acquired = await acquireLease(currentDraft);
            if (!acquired) return;
            restoreResponse = await restore(acquired.token);
          }
        }
        if (!restoreResponse.ok) throw new Error(await readApiError(restoreResponse, t().restoreFailed));
        const restored = await restoreResponse.json();
        if (disposed || recoveryController !== controller) return;
        setDraft(restored);
        if (isShared()) await shared()?.refresh();
        else applyDraftContent(restored);
        draftSession.acceptRestoredContent();
        draftSession.forgetJournal(restored.id);
        setStatus("saved");
        setStatusMessage("");
        toast.success(t().changesRestored);
      });
    } catch (error) {
      if (!disposed && recoveryController === controller && !(error instanceof DOMException && error.name === "AbortError")) {
        await prompts.error(error instanceof Error ? error.message : t().restoreFailed);
      }
    } finally {
      if (recoveryController === controller) recoveryController = null;
      composerTransition.release(reservation);
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const serialized = JSON.stringify({
      draft: content(),
      conversationId: conversationId(),
      sourceMessageId: initial.sourceMessageId,
    } satisfies PreviewInput);
    if (format() !== "markdown" || !identityId()) {
      stopPreview();
      return;
    }
    if (!previewVisible()) {
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

  /** Recipient fields in screen order; Send first takes what each one still holds as typed text. */
  const recipientFields = new Set<MailRecipientField>();
  const registerRecipientField = (field: MailRecipientField) => {
    recipientFields.add(field);
    return () => recipientFields.delete(field);
  };
  const commitRecipientFields = () => {
    for (const field of recipientFields) if (!field.commitPending()) throw new ComposeRecipientPending();
  };

  const validateDelivery = () => {
    commitRecipientFields();
    if (uploads().length > 0) throw new Error(t().finishUploadsBeforeSend);
    if (to().length + cc().length + bcc().length === 0) throw new Error(t().addRecipient);
    if (!body().trim() && !(draft()?.attachments.length ?? props.initialSeed?.attachments.length ?? 0)) {
      throw new Error(t().addContent);
    }
  };

  const reviewSafety = async (
    saved: MailDraft,
    scheduled: boolean,
    abortSignal: AbortSignal,
  ): Promise<{ expectedContentHash: string; safetyApproval?: ComposeSafetyApproval }> => {
    const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["safety-review"].$post(
      {
        param: { mailboxId: props.mailboxId, draftId: saved.id },
        json: { expectedRevision: saved.revision },
      },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, t().safetyReviewFailed));
    const review: DraftSendReview = await response.json();
    if (review.warnings.length === 0) return { expectedContentHash: review.contentHash };
    const choice = await prompts.dialog<"approve" | "attachment">(
      (close) => (
        <div class="flex flex-col gap-3">
          <ScrollArea class="flex max-h-[45vh] flex-col gap-2">
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
          </ScrollArea>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              {t().cancel}
            </Button>
            <Show when={review.warnings.some((warning) => warning.id === "missing_attachment")}>
              <Button variant="secondary" size="sm" type="button" onClick={() => close("attachment")}>
                <i class="ti ti-paperclip" aria-hidden="true" /> {t().addAttachment}
              </Button>
            </Show>
            <Button size="sm" type="button" onClick={() => close("approve")}>
              {scheduled ? t().scheduleAnyway : t().sendAnyway}
            </Button>
          </div>
        </div>
      ),
      { title: t().reviewBeforeSending, icon: "ti ti-shield-check", size: "medium" },
    );
    if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
    if (choice === "attachment") throw new ComposeSafetyAttachmentRequested();
    if (choice !== "approve") throw new ComposeSafetyCancelled();
    return {
      expectedContentHash: review.contentHash,
      safetyApproval: {
        revision: review.revision,
        fingerprint: review.fingerprint,
        warningIds: review.warnings.map((warning) => warning.id),
      },
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
      expectedContentHash: string;
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
      if (!response.ok) {
        const failure = await readApiFailure(response, t().queueFailed);
        if (failure.code === "SEND_CONTENT_CHANGED") lastDeliveryAttempt = null;
        throw failure;
      }
      const command = await response.json();
      return { command, attempt };
    },
    onSuccess: ({ command, attempt }) => {
      lastDeliveryAttempt = null;
      draftSession.forgetJournal(attempt.draftId, { closed: true });
      const returnHref = props.returnHref;
      const scheduled = Boolean(attempt.scheduledAt);
      toast.success(
        scheduled
          ? t().deliveryScheduled({ value: dates.formatDateTime(attempt.scheduledAt!, props.dateConfig) })
          : preferences.undoSeconds > 0
            ? t().messageQueuedUndo
            : t().messageQueued,
      );
      if (isShared() && sharedState()?.dirty) {
        shared()?.freeze();
        return;
      }
      if (props.host || props.popout) return leaveBack("sent");
      const pendingConversationId = command.result.conversationId;
      leaveTo(
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
    for (;;) {
      abortSignal.throwIfAborted();
      validateDelivery();
      if (!sharedCanSend() || tableNeedsCheck()) throw new Error(sharedT().syncFirst);
      const saved = await persist();
      if (!saved) throw new Error(statusMessage());
      const reviewedFingerprint = JSON.stringify(content());
      const reviewed = await reviewSafety(saved, Boolean(delivery.scheduledAt), abortSignal);
      const confirmed = await confirmSharedDraftRecipients({
        changed: () => Boolean(sharedState()?.recipientsChanged),
        content,
        signal: abortSignal,
        confirm: (inventory) => {
          const addresses = [
            `${t().subject}: ${inventory.subject}`,
            `${props.identities.find((identity) => identity.id === inventory.senderIdentityId)?.fromAddress ?? inventory.senderIdentityId}`,
            `To: ${formatMailRecipients(inventory.to).join(", ")}`,
            `Cc: ${formatMailRecipients(inventory.cc).join(", ")}`,
            `Bcc: ${formatMailRecipients(inventory.bcc).join(", ")}`,
          ].join("\n");
          return prompts.confirm(`${sharedT().recipients}\n\n${addresses}`, {
            title: sharedT().recipientsTitle,
            confirmText: sharedT().confirm,
            signal: abortSignal,
          });
        },
        accepted: () => shared()?.recipientsConfirmed(),
      });
      if (!confirmed) throw new ComposeSafetyCancelled();
      // Remote input can arrive while either review dialog is open. Review that exact new content again.
      if (reviewedFingerprint !== JSON.stringify(content())) continue;
      const senderIdentityId = identityId();
      if (!senderIdentityId) throw new Error(t().chooseSenderBeforeSend);
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
          ...reviewed,
          idempotencyKey: crypto.randomUUID(),
        },
      };
    }
  };

  const finishDeliveryTransition = (reservation: ReturnType<typeof composerTransition.reserve>) => {
    if (!reservation) return;
    composerTransition.release(reservation);
    if (attachAfterDeliveryReview && !disposed) {
      attachAfterDeliveryReview = false;
      void chooseAttachments();
    }
  };

  const sendDraft = async (delivery: { scheduledAt?: string }) => {
    if (!editable() || !sharedCanSend() || tableNeedsCheck() || uploads().length > 0) return;
    const reservation = composerTransition.reserve("send");
    if (!reservation) return;
    const preparation = new AbortController();
    deliveryPreparationController = preparation;
    try {
      // Before the retry check: a recipient typed since the failed attempt changes the message.
      commitRecipientFields();
      const previousAttempt = lastDeliveryAttempt;
      const reusable =
        Boolean(send.error()) &&
        !sharedState()?.recipientsChanged &&
        !hasUnsavedChanges() &&
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
      else if (!(error instanceof ComposeSafetyCancelled) && !(error instanceof ComposeRecipientPending)) {
        await prompts.error(error instanceof Error ? error.message : t().messageNotReadySend);
      }
    } finally {
      preparation.abort();
      if (deliveryPreparationController === preparation) deliveryPreparationController = null;
      finishDeliveryTransition(reservation);
    }
  };

  const schedule = async () => {
    if (!editable() || !sharedCanSend() || tableNeedsCheck() || uploads().length > 0) return;
    const reservation = composerTransition.reserve("send");
    if (!reservation) return;
    let scheduledAt: string | null = null;
    try {
      scheduledAt = (await chooseScheduledSendTime(props.dateConfig)) ?? null;
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t().messageNotReadySchedule);
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
              label={t().priority}
              description={t().priorityDescription}
              value={nextPriority}
              onValueChange={(value) => setNextPriority(value === "high" ? "high" : value === "low" ? "low" : "normal")}
              options={[
                { id: "normal", label: t().normal, icon: "ti ti-minus" },
                { id: "high", label: t().high, icon: "ti ti-arrow-up" },
                { id: "low", label: t().low, icon: "ti ti-arrow-down" },
              ]}
            />
            <CheckboxCard
              label={deliveryReceiptSupported() ? t().requestDeliveryReceipt : t().deliveryReceiptsUnavailable}
              description={deliveryReceiptSupported() ? t().deliveryReceiptDescription : t().deliveryReceiptUnsupported}
              icon="ti ti-mail-check"
              value={nextDeliveryReceipt}
              onValueChange={setNextDeliveryReceipt}
              disabled={!deliveryReceiptSupported()}
            />
            <CheckboxCard
              label={t().requestReadReceipt}
              description={t().readReceiptDescription}
              icon="ti ti-eye-check"
              value={nextReadReceipt}
              onValueChange={setNextReadReceipt}
            />
            <NoticeCard tone="neutral">{t().receiptDisclaimer}</NoticeCard>
            <div class="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(false)}>
                {t().cancel}
              </Button>
              <Button size="sm" type="button" onClick={save}>
                <i class="ti ti-check" aria-hidden="true" />
                {t().apply}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().deliveryOptions, icon: "ti ti-adjustments", size: "medium" },
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
            label={t().messageFormat}
            description={t().messageFormatDescription}
            value={format}
            onValueChange={(value) => setFormat(value === "plain" ? "plain" : "markdown")}
            options={[
              { id: "markdown", label: "Markdown", icon: "ti ti-markdown" },
              { id: "plain", label: t().plainText, icon: "ti ti-align-left" },
            ]}
          />
          <div class="flex flex-col gap-2">
            <Show when={props.calendarIntegrationAvailable}>
              <Button variant="secondary" type="button" align="start" class="w-full" onClick={() => close("calendar")}>
                <i class="ti ti-calendar-plus" aria-hidden="true" />
                {t().addCalendarInvitation}
              </Button>
            </Show>
            <Button variant="secondary" type="button" align="start" class="w-full" onClick={() => close("delivery")}>
              <i class="ti ti-mail-cog" aria-hidden="true" />
              {t().deliveryOptions}
              <Show when={deliveryOptionsSummary().length > 0}>
                <span class="ml-auto text-xs font-normal text-dimmed">{deliveryOptionsSummary().join(", ")}</span>
              </Show>
            </Button>
          </div>
          <div class="flex justify-end">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              {t().done}
            </Button>
          </div>
        </div>
      ),
      { title: t().messageOptions, icon: "ti ti-adjustments-horizontal", size: "medium" },
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

  const discard = mutations.create<boolean, { quiet: boolean }>({
    mutation: async ({ quiet }, { abortSignal }) => {
      if (uploadsInProgress()) throw new Error(t().cancelUploadsBeforeDiscard);
      if (!draft()) {
        // A new message that never reached the server lives only on this device: typed input goes for good.
        const changed =
          serializeMailDraftContent(content()) !== initialSerializedContent || [...recipientFields].some((field) => field.pending());
        const confirmed =
          quiet ||
          !changed ||
          (await prompts.confirm(t().discardUnsavedDescription, {
            title: t().discardDraftQuestion,
            confirmText: t().discardDraft,
            variant: "danger",
          }));
        if (!confirmed || abortSignal.aborted) return false;
        clearInitialSeed();
        return true;
      }
      // Only a draft this click created and nobody changed goes without asking: it holds nothing to lose.
      const confirmed =
        quiet ||
        (await prompts.confirm(t().discardSharedDescription, {
          title: t().discardDraftQuestion,
          confirmText: t().discardDraft,
          variant: "danger",
        }));
      if (!confirmed || abortSignal.aborted) return false;
      if (isShared() && !(await persist())) throw new Error(statusMessage());
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
        if (!response.ok) throw new Error(await readApiError(response, t().discardFailed));
        draftSession.forgetJournal(currentDraft.id, { closed: true });
        if (isShared()) await shared()?.discardLocal();
      });
      return true;
    },
    onSuccess: (discarded) => {
      if (!discarded) return;
      leaveBack("discarded");
    },
    onError: (error) => prompts.error(error.message),
  });
  const discardDraft = async (quiet = false) => {
    if (!editable()) return;
    const reservation = composerTransition.reserve("discard");
    if (!reservation) return;
    try {
      await discard.mutate({ quiet });
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
    if (uploadsInProgress()) {
      await prompts.error(t().finishUploadsBeforeClose);
      return;
    }
    const reservation = composerTransition.reserve("handoff");
    if (!reservation) return;
    stopScheduledSave();
    try {
      if (!draft() && !hasUnsavedChanges()) {
        clearInitialSeed();
        leaveBack("closed");
        return;
      }
      if (draft() && !lease() && !isShared()) {
        leaveBack("closed");
        return;
      }
      const currentDraft = await persist();
      if (disposed) return;
      if (!currentDraft) {
        if (isShared() && (await shared()?.flushLocal())) {
          leaveBack("closed");
          return;
        }
        throw new Error(statusMessage());
      }
      try {
        await releaseLease(currentDraft);
      } catch {
        await releaseLeaseOnExit();
      }
      if (!disposed) leaveBack("closed");
    } catch (error) {
      if (!disposed) await prompts.error(error instanceof Error ? error.message : t().closeDraftFailed);
    } finally {
      composerTransition.release(reservation);
    }
  };

  const handoffTo = async (href: (draftId: string) => string, popup: Window): Promise<void> => {
    if (uploadsInProgress()) {
      popup.close();
      await prompts.error(t().finishUploadsBeforeMove);
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
      leaveBack("moved");
    } catch (error) {
      popup.close();
      if (disposed) return;
      if (releasedDraft && !disposed) {
        try {
          await acquireLease(releasedDraft);
        } catch {
          setStatus("readonly");
          setStatusMessage(t().editingRestoreFailed);
        }
      }
      await prompts.error(error instanceof Error ? error.message : t().requestedWindowFailed);
    } finally {
      composerTransition.release(reservation);
    }
  };

  const openWindow = () => {
    const popup = window.open("about:blank", "", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
    if (!popup) return void prompts.error(t().allowPopups);
    if (!draft() && !hasUnsavedChanges() && props.initialSeed) {
      popup.location.replace(mailDraftSeedHref(props.mailboxId, props.initialSeed.id, props.returnHref, { popout: true }));
      leaveBack("moved");
      return;
    }
    void handoffTo((draftId) => draftHref(draftId, true), popup);
  };

  /** Inline: Esc and "Collapse". A draft this click created and nobody changed goes away; any other draft is saved and released. */
  const initialSerializedContent = serializeMailDraftContent(content());
  const initialRevision = props.initialDraft?.revision ?? null;
  // Unchanged means unchanged everywhere: the input, the stored draft (no other session wrote it), no conflict.
  const untouched = () =>
    Boolean(props.host?.fresh) &&
    !draftSession.revisionConflict() &&
    !isShared() &&
    draft()?.revision === initialRevision &&
    serializeMailDraftContent(content()) === initialSerializedContent &&
    (draft()?.attachments.length ?? 0) === 0 &&
    uploads().length === 0;
  const collapse = async () => {
    if (composerTransition.active() !== null) return;
    if (untouched() && editable()) return void (await discardDraft(true));
    await leaveComposer();
  };
  props.host?.register({
    collapse,
    send: () => void sendDraft({}),
    focusText: () => focusEditorAtEnd(),
  });

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
        locale: locale(),
      });
      if (choice !== "takeover" || disposed) return;
      stopHeartbeat();
      setStatus("preparing");
      const acquired = await acquireLease(currentDraft, true);
      if (!disposed && acquired) {
        setStatus(draftSession.revisionConflict() ? "error" : "saved");
        setStatusMessage(draftSession.revisionConflict() ? t().draftRevisionConflict : "");
        toast.success(t().editingAvailable);
      }
    } catch (error) {
      if (!disposed) {
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : t().takeoverFailed);
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
    return conflict ? mailDraftCollaborationCopy(conflict, props.currentActor, locale()).status : statusMessage();
  };
  const connectionUnavailable = () => status() === "readonly" && Boolean(lease()) && !leaseConflict();
  const readonlyActionLabel = () => {
    if (authenticationRequired()) return t().signInAgain;
    const conflict = leaseConflict();
    return conflict ? mailDraftCollaborationCopy(conflict, props.currentActor, locale()).takeoverLabel : t().retry;
  };
  const [signingIn, setSigningIn] = createSignal(false);
  const handleReadonlyAction = async () => {
    if (authenticationRequired()) {
      // The route policy takes this exact draft/seed URL through sign-in and back. The local
      // session checks that local edits can survive reloading before starting that navigation.
      try {
        setSigningIn(true);
        await prepareSignIn();
        draftSession.allowNavigation();
        window.location.reload();
      } catch {
        toast.error(t().draftSaveFailed);
      } finally {
        setSigningIn(false);
      }
      return;
    }
    if (leaseConflict()) void presentLeaseConflict();
    else void resumeCurrentLease();
  };

  const [senderSettingsOpening, setSenderSettingsOpening] = createSignal(false);
  const openSenderSettings = async () => {
    if (senderSettingsOpening()) return;
    setSenderSettingsOpening(true);
    try {
      const settings = await importOnDemand(() => import("./MailboxSettingsDialog"));
      if (!settings || disposed) return;
      const result = await settings.openMailboxSettingsDialog({
        mailboxId: props.mailboxId,
        currentUserEmail: props.currentUserEmail ?? null,
        contactDirectory,
        initialTab: "delivery",
      });
      // The page renders its senders on the server; a fixed sender shows after a reload.
      if (result.workspaceChanged && !disposed) window.location.reload();
    } finally {
      if (!disposed) setSenderSettingsOpening(false);
    }
  };

  const composerIntent = () => draft()?.intent ?? initial.intent;
  const retryPreview = () => void previewQuery.refresh();
  const IdentitySwitcher = () => {
    const label = () => selectedIdentity()?.label ?? t().chooseSender;
    const address = () => selectedIdentity()?.fromAddress ?? "";
    const Content = () => (
      <>
        <span class="shrink-0 text-dimmed">{t().from}</span>
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
            aria-label={t().changeSender({ label: label(), address: address() })}
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
        if (!response.ok) throw new Error(await readApiError(response, t().templatesFailed));
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

  if (props.host) {
    const host = props.host;
    const inlineIntentLabel = () => {
      const intent = composerIntent();
      return intent === "reply"
        ? t().inlineReply
        : intent === "reply_all"
          ? t().inlineReplyAll
          : intent === "forward"
            ? t().inlineForward
            : t().inlineNew;
    };
    // F4: a reply offers to attach the quoted message it answers; a forward already carries it.
    // A shared draft names who writes along, with their caret colour; the carets themselves come from the editor.
    const [sharedPeers, setSharedPeers] = createSignal<{ name: string; color: string }[]>([]);
    createEffect(() => {
      const client = shared();
      if (!client) return setSharedPeers([]);
      const changed = () => {
        const peers = mailDraftPeers(client.doc.getText("codemirror"), client.awareness);
        setSharedPeers([...new Map(peers.map((peer) => [peer.name, { name: peer.name, color: peer.color }])).values()]);
      };
      client.awareness.on("change", changed);
      onCleanup(() => client.awareness.off("change", changed));
      changed();
    });
    createEffect(() => {
      if (!host.summary) return;
      const recipients = parseMailRecipients(to()).map((recipient) => recipient.name || recipient.address);
      host.summary({ subject: subject(), to: recipients });
    });
    // A suggestion from Gustav stays plum until someone types or changes anything, recipients included.
    const suggestionUntouched = () => Boolean(draft()?.suggestion) && serializeMailDraftContent(content()) === initialSerializedContent;
    const quoteLabel = () => {
      const intent = composerIntent();
      const sourceMessageId = draft()?.sourceMessageId ?? initial.sourceMessageId;
      if ((intent !== "reply" && intent !== "reply_all") || !sourceMessageId) return null;
      return host.messageLabel(sourceMessageId);
    };
    const draftMenu = (): DropdownItem[] => [
      {
        items: [
          { label: t().sendLater, icon: "ti ti-clock", disabled: !editable() || !sharedCanSend(), action: () => void schedule() },
          {
            label: t().messageOptions,
            icon: "ti ti-adjustments-horizontal",
            disabled: !editable(),
            action: () => void editMessageOptions(),
          },
          { label: t().inOwnWindow, icon: "ti ti-app-window", disabled: !editable(), action: openWindow },
          ...(editable() && ((draft()?.recoveryCopyCount ?? 0) > 0 || draftSession.localRecoveryCopies().length > 0)
            ? [{ label: t().recoverChanges, icon: "ti ti-history", action: () => void restoreRecoveryCopy() }]
            : []),
        ],
      },
      {
        items: [
          {
            label: t().discardDraft,
            icon: "ti ti-trash",
            variant: "danger",
            disabled: !editable() || discard.loading(),
            action: () => void discardDraft(),
          },
        ],
      },
    ];
    // Esc leaves full screen first, then collapses the draft. A menu, a completion list, or a dialog takes Esc first.
    const onKeyDown = (event: KeyboardEvent) => {
      // Safari ends an IME composition with Escape and reports that key as keyCode 229, not as composing.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (host.fullscreen()) host.toggleFullscreen();
      else void collapse();
    };
    return (
      <section
        ref={setSurface}
        class="mail-inline-draft"
        data-mail-inline-draft
        data-intent={composerIntent()}
        data-fullscreen={host.fullscreen() ? "" : undefined}
        data-history-label={t().historyBelow}
        data-suggestion={suggestionUntouched() ? "" : undefined}
        aria-label={t().inlineDraftLabel({ intent: inlineIntentLabel() })}
        onKeyDown={onKeyDown}
      >
        <FileDropTarget
          for={surface()}
          label={t().dropFiles}
          disabled={!editable()}
          onDrop={(files) => {
            if (files.length > 0 && !disposed) void attachments.addFiles(files);
          }}
        />
        <header class="mail-inline-draft-head">
          <Show
            when={suggestionUntouched()}
            fallback={
              <span class="mail-inline-draft-intent">
                <i class={`ti ${composerIntent() === "new" ? "ti-pencil" : intentIcon(composerIntent())}`} aria-hidden="true" />
                {inlineIntentLabel()}
              </span>
            }
          >
            <span class="mail-inline-draft-intent">
              <i class="ti ti-sparkles" aria-hidden="true" />
              {/* The account that suggested it; a pod from before `suggestedBy` still names the last (automated) editor. */}
              {t().suggestionFrom({ name: draft()?.suggestedBy ?? draft()?.lastEditedByDisplayName ?? "" })}
            </span>
          </Show>
          <span class="mail-inline-draft-field-label">{t().to}</span>
          <div class="mail-inline-draft-recipients">
            <MailRecipientInput
              register={registerRecipientField}
              mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
              placeholder={t().recipients}
              value={to}
              onChange={setTo}
              disabled={fieldsDisabled()}
              readOnly={paused()}
            />
          </div>
          <Show when={!showCc()}>
            <Button variant="ghost" size="sm" type="button" disabled={!editable()} onClick={() => setShowCc(true)}>
              {t().ccBcc}
            </Button>
          </Show>
          <Show when={sharedPeers().length > 0}>
            <span class="mail-inline-draft-peers" data-mail-draft-peers>
              <For each={sharedPeers().slice(0, 3)}>
                {(peer) => (
                  <span class="mail-inline-draft-peer" style={{ "--mail-peer-color": peer.color }} aria-hidden="true">
                    {peer.name
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((part) => part[0]!.toUpperCase())
                      .join("")}
                  </span>
                )}
              </For>
              {t().writingAlong({
                names: sharedPeers()
                  .map((peer) => peer.name)
                  .join(", "),
                count: sharedPeers().length,
              })}
            </span>
          </Show>
          <span class="mail-inline-draft-head-tools">
            <Dropdown.Root position="bottom-right" width="16rem" items={draftMenu()}>
              <Dropdown.Trigger iconOnly type="button" variant="ghost" size="sm" label={t().draftActions}>
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
            <Tooltip.Anchor content={host.fullscreen() ? t().exitFullscreen : t().enterFullscreen}>
              <IconButton
                type="button"
                size="sm"
                label={host.fullscreen() ? t().exitFullscreen : t().enterFullscreen}
                aria-pressed={host.fullscreen()}
                data-mail-draft-fullscreen
                onClick={host.toggleFullscreen}
              >
                <i class={`ti ${host.fullscreen() ? "ti-arrows-minimize" : "ti-arrows-maximize"}`} aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
            <Tooltip.Anchor content={t().collapseDraft}>
              <IconButton
                type="button"
                size="sm"
                label={t().collapseDraft}
                data-mail-draft-collapse
                disabled={composerTransition.active() !== null}
                onClick={() => void collapse()}
              >
                <i class="ti ti-chevron-up" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </span>
        </header>
        <div class="mail-inline-draft-meta">
          <IdentitySwitcher />
          <span class="mail-inline-draft-meta-subject">
            <span class="shrink-0 text-dimmed">{t().subject}</span>
            <TextInput
              class="mail-inline-draft-subject"
              aria-label={t().subject}
              value={subject}
              onValueChange={setSubject}
              maxLength={998}
              disabled={fieldsDisabled()}
              readOnly={paused()}
            />
          </span>
        </div>
        <Show when={showCc()}>
          <div class="mail-inline-draft-rows">
            <span class="mail-inline-draft-field-label">Cc</span>
            <MailRecipientInput
              register={registerRecipientField}
              mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
              placeholder={t().ccRecipients}
              value={cc}
              onChange={setCc}
              disabled={fieldsDisabled()}
              readOnly={paused()}
            />
            <span class="mail-inline-draft-field-label">Bcc</span>
            <MailRecipientInput
              register={registerRecipientField}
              mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
              placeholder={t().bccRecipients}
              value={bcc}
              onChange={setBcc}
              disabled={fieldsDisabled()}
              readOnly={paused()}
            />
          </div>
        </Show>

        <Show when={verifiedIdentities().length === 0}>
          <MailSenderUnavailableNotice
            identities={props.identities}
            onOpenSettings={props.canManageMailbox ? () => void openSenderSettings() : undefined}
            opening={senderSettingsOpening()}
          />
        </Show>
        <Show when={status() === "error" || status() === "readonly"}>
          <div
            class="mail-inline-draft-notice"
            data-tone={status() === "error" || connectionUnavailable() ? "danger" : "neutral"}
            role="status"
          >
            <span class="min-w-0 flex-1">{collaborationStatus()}</span>
            <Show when={!isShared() && (status() === "error" || (draftSession.revisionConflict() && !draft()?.conversationId))}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                loading={saveLifecycleCopy.loading()}
                onClick={() => void recoverSaveError()}
              >
                {draftSession.revisionConflict() ? (draft()?.conversationId ? t().recoverChanges : t().saveAsNewDraft) : t().retry}
              </Button>
            </Show>
            <Show when={status() === "readonly" && (authenticationRequired() || (draft() && (lease() || leaseConflict())))}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={signingIn()}
                aria-busy={signingIn()}
                onClick={handleReadonlyAction}
              >
                {readonlyActionLabel()}
              </Button>
            </Show>
            <Show when={draftSession.revisionConflict()}>
              <Button variant="secondary" size="sm" type="button" onClick={() => void copyLifecycleText()}>
                {t().copyText}
              </Button>
            </Show>
          </div>
        </Show>
        <Show when={draftSession.localCopyFailed()}>
          <div class="mail-inline-draft-notice" data-tone="danger" role="status">
            {t().localRecoveryUnavailable}
          </div>
        </Show>
        <Show when={draft()?.restSourceDraftId}>
          {(source) => (
            <div class="mail-inline-draft-notice" data-tone="neutral">
              <span class="min-w-0 flex-1">{sharedT().restLabel}</span>
              <Button size="sm" variant="secondary" type="button" onClick={() => openOtherDraft(source())}>
                {sharedT().restSource}
              </Button>
            </div>
          )}
        </Show>
        <Show when={isShared() && !shared() && status() === "error"}>
          <div class="mail-inline-draft-notice" data-tone="danger" role="alert">
            <span class="min-w-0 flex-1">{statusMessage()}</span>
            <Button size="sm" variant="secondary" onClick={() => void draftSession.retryShared()}>
              {sharedT().retry}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void draftSession.retryShared(false)}>
              {sharedT().forget}
            </Button>
          </div>
        </Show>
        <Show when={lifecycleTransition() && !sharedState()?.recoveryDraft ? lifecycleTransition() : null}>
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
        <Show when={sharedState()?.recoveryDraft || sharedState()?.restUnchanged}>
          <div class="mail-inline-draft-notice" data-tone="neutral" role="status">
            <span class="min-w-0 flex-1">{sharedState()?.recoveryDraft ? sharedT().restSaved : sharedT().restUnchanged}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const recovery = sharedState()?.recoveryDraft;
                if (recovery) openOtherDraft(recovery.id);
                else window.location.reload();
              }}
            >
              {sharedState()?.recoveryDraft ? sharedT().openRest : sharedT().reopen}
            </Button>
          </div>
        </Show>

        <MailComposerEditor
          shared={shared}
          sharedState={sharedState}
          onTableCheck={setTableNeedsCheck}
          format={format}
          body={body}
          onBodyInput={setBody}
          editable={editable}
          paused={paused}
          completions={slashCompletion}
          panes={currentComposerPanes}
          onPanesChange={updateComposerPanes}
          preview={preview}
          previewError={previewError}
          previewPending={() => previewQuery.loading() || previewQuery.refreshing()}
          onRetryPreview={retryPreview}
          onEditorReady={editorReady}
          liveDictation={props.liveDictation}
          onAttachImages={() => void chooseAttachments()}
          onDroppedImages={(files) => {
            if (editable()) void attachments.addFiles(files);
          }}
          inline={{ preview: inlinePreview, formatting: inlineFormatting }}
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

        {/* The preview already shows the signature and the quote as the mail arrives. */}
        <Show when={!inlinePreview()}>
          <MailInlineSignature
            mailboxId={props.mailboxId}
            senderIdentityId={identityId}
            signatureTemplateId={signatureTemplateId}
            format={format}
          />
        </Show>
        {/* The empty room below the text belongs to the text: a click there continues writing at its end. */}
        <div class="mail-inline-draft-space" aria-hidden="true" onClick={focusEditorAtEnd} />
        <Show when={!inlinePreview() && quoteLabel()}>
          {(label) => (
            <div class="mail-inline-draft-quote" data-mail-draft-quote>
              <i class="ti ti-quote" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">
                {quoteSource() ? t().quoteAttached({ label: label() }) : t().quoteOffer({ label: label() })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={!editable()}
                aria-pressed={Boolean(quoteSource())}
                onClick={() =>
                  setQuoteSource((current) => (current ? null : { locale: locale(), timeZone: props.dateConfig.timeZone ?? "UTC" }))
                }
              >
                {quoteSource() ? t().removeQuote : t().attachQuote}
              </Button>
            </div>
          )}
        </Show>

        <footer class="mail-inline-draft-foot">
          <span class="mail-inline-draft-tools">
            <Show when={format() === "markdown"}>
              <Tooltip.Anchor content={t().formatting}>
                <IconButton
                  type="button"
                  size="sm"
                  label={t().formatting}
                  aria-pressed={inlineFormatting()}
                  disabled={!editable() || inlinePreview()}
                  onClick={() => setInlineFormatting((value) => !value)}
                >
                  <i class="ti ti-typography" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            </Show>
            <Tooltip.Anchor content={t().attachFiles}>
              <IconButton type="button" size="sm" label={t().attachFiles} disabled={!editable()} onClick={() => void chooseAttachments()}>
                <i class="ti ti-paperclip" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
            <Show when={signatureChoiceVisible()}>
              <MailComposerSignature
                quiet
                signatures={props.signatures}
                value={signatureTemplateId()}
                senderDefaultId={senderDefaultSignatureId()}
                disabled={!editable()}
                onChange={setSignatureTemplateId}
              />
            </Show>
            <Tooltip.Anchor content={t().writeWithAi}>
              <IconButton
                type="button"
                size="sm"
                class="mail-inline-draft-ai"
                label={t().writeWithAi}
                disabled={!editable() || uploads().length > 0 || composeWithAi.loading()}
                onClick={() =>
                  void composeWithAi
                    .mutate()
                    .catch((error: unknown) => prompts.error(error instanceof Error ? error.message : t().assistantFailed))
                }
              >
                <i class="ti ti-sparkles" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
            <Show when={format() === "markdown"}>
              {/* A visible switch, not a menu entry: the person checks exactly how the mail arrives. */}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                class="mail-inline-draft-preview-toggle"
                aria-pressed={inlinePreview()}
                title={inlinePreview() ? t().hidePreview : t().showPreview}
                data-mail-draft-preview
                onClick={() => setInlinePreview((value) => !value)}
              >
                <i class={`ti ${inlinePreview() ? "ti-pencil" : "ti-eye"}`} aria-hidden="true" />
                <span class="mail-inline-draft-preview-label">{inlinePreview() ? t().write : t().preview}</span>
              </Button>
            </Show>
          </span>
          <span class="mail-inline-draft-status" data-mail-save-status={saveStatus()} role="status" aria-live="polite" title={saveState()}>
            <Show when={!suggestionUntouched()} fallback={<span class="mail-inline-draft-suggestion-hint">{t().suggestionHint}</span>}>
              <Show when={saveState()}>
                <i
                  class={`ti ${saveStatus() === "saved" ? "ti-cloud-check" : saveStatus() === "local" ? "ti-device-laptop" : "ti-clock"}`}
                  aria-hidden="true"
                />
                {saveState()}
              </Show>
            </Show>
          </span>
          <SplitButton
            class="mail-compose-action"
            size="sm"
            type="button"
            loading={send.loading()}
            disabled={!editable() || !sharedCanSend() || tableNeedsCheck() || uploads().length > 0}
            menuLabel={t().moreSendOptions}
            tooltip={`${t().send} (${sendShortcutLabel()})`}
            items={[
              { label: t().saveAsDraft, icon: "ti ti-device-floppy", action: () => void leaveComposer() },
              { label: t().sendLater, icon: "ti ti-clock", action: () => void schedule() },
            ]}
            onClick={() => void sendDraft({})}
          >
            <i class="ti ti-send" aria-hidden="true" />
            {t().send}
          </SplitButton>
        </footer>
      </section>
    );
  }

  return (
    <div ref={setSurface} class="mail-composer-surface relative h-full min-w-0 overflow-hidden">
      {/* The composer is a page or a popout window of its own; either way, all of it takes attachments. */}
      <FileDropTarget
        for={surface()}
        label={t().dropFiles}
        disabled={!editable()}
        onDrop={(files) => {
          if (files.length > 0 && !disposed) void attachments.addFiles(files);
        }}
      />
      <Show when={!props.popout}>
        <header
          class="flex shrink-0 items-center gap-2 bg-[var(--ui-surface-subtle)] px-3 py-2"
          classList={{ "flex-wrap": status() === "error" }}
        >
          <Tooltip.Anchor content={t().backToMailbox}>
            <IconButton
              type="button"
              label={t().backToMailbox}
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
              class="min-w-0 text-xs"
              classList={{
                truncate: status() !== "error",
                "text-red-600 dark:text-red-300": status() === "error" || connectionUnavailable(),
                "basis-full whitespace-normal": status() === "error",
                "text-dimmed": status() === "readonly" && !connectionUnavailable(),
              }}
              role="status"
            >
              {collaborationStatus()}
            </span>
          </Show>
          <Show when={status() === "readonly" && (authenticationRequired() || (draft() && (lease() || leaseConflict())))}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={signingIn()}
              aria-busy={signingIn()}
              onClick={handleReadonlyAction}
            >
              {readonlyActionLabel()}
            </Button>
          </Show>
          <Show when={!isShared() && (status() === "error" || (draftSession.revisionConflict() && !draft()?.conversationId))}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              loading={saveLifecycleCopy.loading()}
              onClick={() => void recoverSaveError()}
            >
              {draftSession.revisionConflict() ? (draft()?.conversationId ? t().recoverChanges : t().saveAsNewDraft) : t().retry}
            </Button>
          </Show>
          <Show when={editable() && ((draft()?.recoveryCopyCount ?? 0) > 0 || draftSession.localRecoveryCopies().length > 0)}>
            <Button variant="secondary" size="sm" type="button" onClick={() => void restoreRecoveryCopy()}>
              <i class="ti ti-history" aria-hidden="true" /> {t().recoverChanges}
            </Button>
          </Show>
          <Tooltip.Anchor content={t().openInNewWindow}>
            <IconButton type="button" label={t().openInNewWindow} disabled={!editable()} onClick={openWindow}>
              <i class="ti ti-app-window" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
        </header>
      </Show>

      <Show when={!isShared() && saveState()}>
        <div class="shrink-0 px-3 py-1 text-xs text-secondary" data-mail-save-status={saveStatus()} role="status" aria-live="polite">
          {saveState()}
        </div>
      </Show>
      <Show when={draftSession.localCopyFailed()}>
        <div class="px-3 py-2 text-xs text-red-600 dark:text-red-300" role="status">
          {t().localRecoveryUnavailable}
        </div>
      </Show>
      <Show when={draftSession.revisionConflict()}>
        <div class="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => void copyLifecycleText()}>
            {t().copyText}
          </Button>
        </div>
      </Show>

      <Show when={props.popout && (status() === "error" || status() === "readonly")}>
        <div
          class="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 text-xs"
          classList={{
            "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300": status() === "error" || connectionUnavailable(),
            "border-b border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] text-secondary":
              status() === "readonly" && !connectionUnavailable(),
          }}
          role="status"
        >
          <span class="min-w-0 flex-1" classList={{ "basis-full": status() === "error" }}>
            {collaborationStatus()}
          </span>
          <Show when={!isShared() && (status() === "error" || (draftSession.revisionConflict() && !draft()?.conversationId))}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              loading={saveLifecycleCopy.loading()}
              onClick={() => void recoverSaveError()}
            >
              {draftSession.revisionConflict() ? (draft()?.conversationId ? t().recoverChanges : t().saveAsNewDraft) : t().retry}
            </Button>
          </Show>

          <Show when={status() === "readonly" && (authenticationRequired() || (draft() && (lease() || leaseConflict())))}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={signingIn()}
              aria-busy={signingIn()}
              onClick={handleReadonlyAction}
            >
              {readonlyActionLabel()}
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={draft()?.restSourceDraftId}>
        {(source) => (
          <div class="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-secondary">
            <span>{sharedT().restLabel}</span>
            <ButtonLink size="sm" variant="secondary" href={mailDraftHref(props.mailboxId, source(), props.returnHref)}>
              {sharedT().restSource}
            </ButtonLink>
          </div>
        )}
      </Show>

      <Show when={isShared() && !shared() && status() === "error"}>
        <div
          class="absolute inset-x-3 bottom-14 z-30 flex max-h-[45%] flex-wrap items-center gap-2 overflow-y-auto rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3 text-sm shadow-[var(--k2b-shadow-toolbar)]"
          role="alert"
        >
          <span class="min-w-0 flex-1">{statusMessage()}</span>
          <Button size="sm" variant="secondary" onClick={() => void draftSession.retryShared()}>
            {sharedT().retry}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void draftSession.retryShared(false)}>
            {sharedT().forget}
          </Button>
        </div>
      </Show>
      <Show when={props.popout && editable() && (draft()?.recoveryCopyCount ?? 0) > 0}>
        <div class="flex shrink-0 items-center gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <span class="min-w-0 flex-1">{t().conflictCopiesAvailable}</span>
          <Button variant="secondary" size="sm" type="button" onClick={() => void restoreRecoveryCopy()}>
            <i class="ti ti-history" aria-hidden="true" /> {t().recover}
          </Button>
        </div>
      </Show>

      <Show when={props.popout}>
        <div class="flex shrink-0 items-center bg-[var(--ui-surface-subtle)] px-3 py-1.5">
          <IdentitySwitcher />
        </div>
      </Show>

      <Show when={lifecycleTransition() && !sharedState()?.recoveryDraft ? lifecycleTransition() : null}>
        {(transition) => (
          <div class={isShared() ? "absolute inset-x-0 bottom-14 z-30 max-h-[45%] overflow-y-auto" : undefined}>
            <MailComposerLifecycleNotice
              transition={transition()}
              savingCopy={saveLifecycleCopy.loading()}
              onCopyText={() => void copyLifecycleText()}
              onSaveAsNew={() => void saveLifecycleCopy.mutate()}
              onOpenMessage={openLifecycleMessage}
            />
          </div>
        )}
      </Show>

      <Show when={verifiedIdentities().length === 0}>
        <MailSenderUnavailableNotice
          class="mx-3 mt-3"
          identities={props.identities}
          onOpenSettings={props.canManageMailbox ? () => void openSenderSettings() : undefined}
          opening={senderSettingsOpening()}
        />
      </Show>

      <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3">
        <div class="grid shrink-0 gap-1.5 py-1.5 text-sm lg:grid-cols-2">
          <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 lg:col-span-2">
            <span class="text-dimmed">{t().to}</span>
            <div class="flex min-w-0 items-center gap-2">
              <div class="min-w-0 flex-1">
                <MailRecipientInput
                  register={registerRecipientField}
                  mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
                  placeholder={t().recipients}
                  value={to}
                  onChange={setTo}
                  disabled={fieldsDisabled()}
                  readOnly={paused()}
                />
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
              <MailRecipientInput
                register={registerRecipientField}
                mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
                placeholder={t().ccRecipients}
                value={cc}
                onChange={setCc}
                disabled={fieldsDisabled()}
                readOnly={paused()}
              />
            </div>
            <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2">
              <span class="text-dimmed">Bcc</span>
              <MailRecipientInput
                register={registerRecipientField}
                mailboxId={props.mailboxRecipientSuggestions ? props.mailboxId : undefined}
                placeholder={t().bccRecipients}
                value={bcc}
                onChange={setBcc}
                disabled={fieldsDisabled()}
                readOnly={paused()}
              />
            </div>
          </Show>
          <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 lg:col-span-2">
            <span class="text-dimmed">{t().subject}</span>
            <TextInput
              aria-label={t().subject}
              value={subject}
              onValueChange={setSubject}
              maxLength={998}
              disabled={fieldsDisabled()}
              readOnly={paused()}
            />
          </div>
        </div>

        <MailComposerEditor
          shared={shared}
          sharedState={sharedState}
          onTableCheck={setTableNeedsCheck}
          format={format}
          body={body}
          onBodyInput={setBody}
          editable={editable}
          paused={paused}
          completions={slashCompletion}
          panes={currentComposerPanes}
          onPanesChange={updateComposerPanes}
          preview={preview}
          previewError={previewError}
          previewPending={() => previewQuery.loading() || previewQuery.refreshing()}
          onRetryPreview={retryPreview}
          onEditorReady={editorReady}
          liveDictation={props.liveDictation}
          onAttachImages={() => void chooseAttachments()}
          onDroppedImages={(files) => {
            if (editable()) void attachments.addFiles(files);
          }}
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

      <Show when={sharedState()?.recoveryDraft || sharedState()?.restUnchanged}>
        <div
          class="absolute inset-x-3 bottom-14 z-30 flex max-h-[45%] flex-wrap items-center gap-2 overflow-y-auto rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-3 text-sm shadow-[var(--k2b-shadow-toolbar)]"
          role="status"
        >
          <span class="min-w-0 flex-1">{sharedState()?.recoveryDraft ? sharedT().restSaved : sharedT().restUnchanged}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const recovery = sharedState()?.recoveryDraft;
              if (recovery) openOtherDraft(recovery.id);
              else window.location.reload();
            }}
          >
            {sharedState()?.recoveryDraft ? sharedT().openRest : sharedT().reopen}
          </Button>
        </div>
      </Show>
      {/* Phones set the tools closer, so the labelled send action and every tool keep one row in each language. */}
      <footer class="flex shrink-0 items-center gap-1 sm:gap-2 bg-[var(--ui-surface-subtle)] px-3 py-2">
        <SplitButton
          class="mail-compose-action"
          size="sm"
          type="button"
          loading={send.loading()}
          disabled={!editable() || !sharedCanSend() || tableNeedsCheck() || uploads().length > 0}
          menuLabel={t().moreSendOptions}
          tooltip={`${t().send} (${sendShortcutLabel()})`}
          items={[
            { label: t().saveAsDraft, icon: "ti ti-device-floppy", action: () => void leaveComposer() },
            { label: t().sendLater, icon: "ti ti-clock", action: () => void schedule() },
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
          aria-label={t().writeWithAi}
          loading={composeWithAi.loading()}
          disabled={!editable() || uploads().length > 0 || composeWithAi.loading()}
          onClick={() =>
            void composeWithAi
              .mutate()
              .catch((error: unknown) => prompts.error(error instanceof Error ? error.message : t().assistantFailed))
          }
        >
          <i class="ti ti-sparkles" aria-hidden="true" />
          <span class="hidden sm:inline">{t().writeWithAi}</span>
        </Button>
        <Show when={signatureChoiceVisible()}>
          <MailComposerSignature
            signatures={props.signatures}
            value={signatureTemplateId()}
            senderDefaultId={senderDefaultSignatureId()}
            disabled={!editable()}
            onChange={setSignatureTemplateId}
          />
        </Show>
        <Tooltip.Anchor
          content={
            deliveryOptionsSummary().length > 0
              ? t().messageOptionsSummary({ options: deliveryOptionsSummary().join(", ") })
              : t().messageOptions
          }
        >
          <Button
            size="sm"
            variant="secondary"
            type="button"
            class="relative"
            aria-label={t().messageOptions}
            disabled={!editable()}
            onClick={() => void editMessageOptions()}
          >
            <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
            <span class="hidden sm:inline">{t().options}</span>
            <Show when={deliveryOptionsSummary().length > 0}>
              <span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ui-app-accent-border)]" aria-hidden="true" />
            </Show>
          </Button>
        </Tooltip.Anchor>
        <Tooltip.Anchor content={t().attachFiles}>
          <IconButton
            size="sm"
            variant="secondary"
            type="button"
            label={t().attachFiles}
            disabled={!editable()}
            onClick={() => void chooseAttachments()}
          >
            <i class="ti ti-paperclip" aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
        <span class="flex-1" />
        <Tooltip.Anchor content={t().discardDraft}>
          <IconButton
            type="button"
            label={t().discardDraft}
            disabled={!editable() || discard.loading()}
            onClick={() => void discardDraft()}
          >
            <i class={`ti ${discard.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
          </IconButton>
        </Tooltip.Anchor>
      </footer>
      {/* A popout that the browser keeps open after Send or Discard says what happened instead of loading the mailbox. */}
      <Show when={popoutDone()}>
        {(outcome) => (
          <div
            ref={(overlay) => {
              // The covered composer leaves the keyboard and screen readers; the confirmation takes the focus.
              queueMicrotask(() => {
                for (const child of overlay.parentElement?.children ?? []) if (child !== overlay) child.setAttribute("inert", "");
                overlay.querySelector<HTMLElement>("button")?.focus();
              });
            }}
            role="status"
            class="absolute inset-0 z-40 flex items-center justify-center bg-[var(--ui-surface)] p-6"
          >
            <Placeholder
              icon={outcome() === "sent" ? "ti ti-send" : outcome() === "discarded" ? "ti ti-trash" : "ti ti-device-floppy"}
              title={outcome() === "sent" ? t().messageQueued : outcome() === "discarded" ? t().popoutDiscarded : t().popoutSaved}
              description={t().popoutCloseHint}
              action={
                <Button variant="secondary" type="button" onClick={() => window.close()}>
                  {t().closeWindow}
                </Button>
              }
            />
          </div>
        )}
      </Show>
    </div>
  );
}
