import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { registerSearchNavigation } from "@k2b/cloud/browser/search";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { clipboard, files } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import { FileDropTarget, NoticeCard, personColor, prompts, ScrollArea, toast, useLocale } from "@k2b/ui";
import { createCodeMirror } from "solid-codemirror";
import { type Accessor, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { apiClient } from "@/api/client";
import type { NoteAuthors } from "../../../../lib/activity-actions";
import type { AnnotationProjection } from "../../../../lib/annotation-contracts";
import { extractNamedBlockSummaries, type NamedBlockSummary } from "../../../../lib/named-blocks";
import { extractHeadingLines, headingAtLine } from "../../../../lib/note-insights";
import { deriveNoteTitle } from "../../../../lib/note-title";
import { inheritPresentationMode, requestedPresentationMode } from "../../../../lib/presentation-url";
import type { Backlink } from "../../../../service/links";
import { editor } from "../../../lib/editor";
import { extractAttachmentIds } from "../../../lib/editor/attachment-url";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "../../../lib/editor/fade-scroll-margins";
import { listCommandsExtension } from "../../../lib/editor/list-commands";
import { queryBlockMessages } from "../../../lib/editor/query-block-messages";
import { createQueryBlockPreviews } from "../../../lib/editor/query-blocks";
import { remoteCursors } from "../../../lib/editor/remote-cursors";
import { pressMissedEditor } from "../../../lib/editor/surface-press";
import { consumeInitialTitleSelection, handleSoftNoteNavigationRequests, type SoftNavigationResult } from "../../../lib/soft-navigation";
import { yjs } from "../../../lib/yjs";
import { isolateYjsHistory } from "../../../lib/yjs/history";
import { applyToYText, changesBetween, rebaseOnto } from "../../../lib/yjs/lazy-collab";
import { notebookWorkspaceMessages } from "../../messages";
import { createEditorComments } from "../comments/EditorComments";
import {
  ACTIVE_HEADING_EVENT,
  type ActiveHeadingEventDetail,
  ATTACHMENTS_UPDATE_EVENT,
  DETAIL_PANEL_STATE_EVENT,
  EDITOR_COPY_EVENT,
  EDITOR_DOWNLOAD_EVENT,
  EDITOR_INSERT_ATTACHMENT_EVENT,
  EDITOR_PDF_EVENT,
  type EditorPdfEventDetail,
  JUMP_TO_PARTICIPANT_EVENT,
  type JumpToParticipantEventDetail,
  NAMED_BLOCK_SCROLL_EVENT,
  NAMED_BLOCKS_UPDATE_EVENT,
  NOTE_SOFT_NAVIGATED_EVENT,
  NOTE_TITLE_CHANGED_EVENT,
  PRESENCE_EVENT,
  PRESENCE_LOCATIONS_EVENT,
  RECONNECT_EVENT,
  RICH_MODE_CHANGED_EVENT,
  SIDEBAR_FILTER_CHANGED_EVENT,
  SYNC_STATE_EVENT,
  SYNC_STATE_REQUEST_EVENT,
  TASKS_UPDATE_EVENT,
  TOC_SCROLL_EVENT,
  TOC_UPDATE_EVENT,
  TOGGLE_RICH_MODE_EVENT,
} from "../detail/events";
import { extractTaskProgress } from "../detail/tasks";
import type { extractTocFromMarkdown } from "../detail/toc";
import { followFullWidth } from "../full-width";
import { writeSettings } from "../settings/NotebookSettingsStore";
import {
  NAVIGATION_FOCUS_EVENT,
  NAVIGATION_VISIBILITY_EVENT,
  NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT,
} from "../sidebar/navigation-visibility";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import type { Attachment, AttachmentRef } from "./attachments-client";
import { formatBytes, insertAttachment, MAX_ATTACHMENT_SIZE_BYTES, maybeShrinkOversizeImage, uploadAndInsert } from "./attachments-client";
import EditorToolbar, { formattingKeymap } from "./EditorToolbar";
import { caretFormat, sameCaretFormat } from "./editor-actions";
import { createLinkedHeadingJump, type LinkedHeading } from "./linked-heading";
import { createNoteNavigationCoordinator, headingFromHash, resolveSameNotebookNoteTarget } from "./note-navigation";
import { NOTE_PREVIEW_ID } from "./note-preview";
import { createNotePrintCopy } from "./note-print-copy";
import { participantCursors, presenceLocations } from "./presence-locations";
import { keepReadingPosition, previewReadingPosition, type ReadingPosition, scrollToReadingPosition } from "./reading-position";
import { slashCommandsExtension } from "./slash-commands";
import { createSyncEnded, SyncEndedBar } from "./sync-ended";
import { createSyncStateBridge } from "./sync-state";
import { createTabKeyPreference } from "./tab-key-preference";

const TOC_DEBOUNCE_MS = 300;
/** The origin of the edits made before the live document arrived, so they undo as one step. */
const FIRST_EDITS = Symbol("first edits");
/** Marks the editor's own catch-up with the live document, which is no edit of the person's. */
const firstEditsSettled = Annotation.define<boolean>();
/** How long leaving the note waits for the first edits to reach the live note before it asks. */
const FIRST_EDITS_LEAVE_WAIT_MS = 5_000;
/** How often a note that is only read tries again to load a newer saved text, waiting 1, 2, then 4 s. */
const SAVED_TEXT_RETRIES = 3;
type LeaveGuard = Pick<ReturnType<typeof createSyncEnded>, "confirmLeave" | "releaseLeave">;
type EditorInstanceProps = {
  noteId: string;
  noteTitle: string;
  notebookId: string;
  noteLockedAt: string | null;
  historyIncomplete: boolean;
  notebookName: string;
  appUrl: string;
  userId: string;
  displayName: string;
  /** The saved Markdown the note opens with; collaboration connects on the first edit. */
  initialContent: string | null;
  initialPanelOpen: boolean;
  initialRichMode: "rich" | "source";
  readOnly?: boolean;
  /** Write access to the note: commenting needs it, also where the editor only shows the text. */
  canWrite: boolean;
  /** The note's comments from the server response; a note opened in the page loads its own. */
  initialAnnotations?: AnnotationProjection | null;
};

const CURSOR_IDLE_TIMEOUT_MS = 8_000;

type SoftNavigatedDetail = {
  noteAuthors: NoteAuthors;
  noteId: string;
  noteTitle: string;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  historyIncomplete: boolean;
  isLocked: boolean;
  tocItems: ReturnType<typeof extractTocFromMarkdown>;
  taskProgress: ReturnType<typeof extractTaskProgress>;
  attachments: Attachment[];
  backlinks: Backlink[];
  namedBlocks: ReturnType<typeof extractNamedBlockSummaries>;
};

type LoadedNote = {
  source: string;
  href: string;
  props: EditorInstanceProps;
  eventDetail: SoftNavigatedDetail;
};

type Props = EditorInstanceProps & {
  initialHref: string;
  initialDetail: SoftNavigatedDetail;
};

export default function NoteEditor(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const { initialHref, initialDetail, ...initialEditorProps } = props;
  const [current, setCurrent] = createSignal<EditorInstanceProps>(initialEditorProps);
  // Read before anything mounts: the first editor opens where the reader scrolled the server preview.
  const preview = document.getElementById(NOTE_PREVIEW_ID);
  let previewPosition = preview ? previewReadingPosition(preview) : null;
  const [routeSource, setRouteSource] = createSignal(initialHref);
  const [failedSource, setFailedSource] = createSignal<string | null>(null);
  const initialHeading = headingFromHash(window.location.hash);
  const [linkedHeading, setLinkedHeading] = createSignal<LinkedHeading | null>(
    initialHeading ? { noteId: initialEditorProps.noteId, id: initialHeading } : null,
  );
  let shownHref = window.location.href;
  let restoringShownHref = false;
  let leaveGuard: LeaveGuard | undefined;
  let pendingGuardedNavigations = 0;
  const registerLeaveGuard = (guard: LeaveGuard) => {
    leaveGuard = guard;
    return () => {
      if (leaveGuard === guard) leaveGuard = undefined;
    };
  };
  const navigation = createNoteNavigationCoordinator({
    initialSource: initialHref,
    currentNoteShortId: () => current().noteId,
    currentHref: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
    setSource: setRouteSource,
    pushHistory: (href) => window.history.pushState({}, "", href),
    showHeading: (noteId, id) => setLinkedHeading(id ? { noteId, id } : null),
  });

  const requestNote = async (href: string, abortSignal: AbortSignal): Promise<LoadedNote> => {
    const res = await apiClient[":id"]["route-state"].$get(
      {
        param: { id: props.notebookId },
        query: { href },
      },
      { init: { signal: abortSignal } },
    );
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const payload = await res.json();
    if (payload.kind !== "ok") throw new Error(`Navigation requires document fallback: ${payload.reason}`);
    const { note, detail, href: canonicalHref } = payload.state;

    return {
      source: href,
      href: canonicalHref,
      props: {
        ...current(),
        noteId: note.id,
        noteTitle: note.title,
        noteLockedAt: note.lockedAt,
        historyIncomplete: note.historyIncomplete,
        initialContent: note.contentMd,
        initialAnnotations: null,
      },
      eventDetail: detail,
    };
  };

  const loadNote = async (href: string, abortSignal: AbortSignal): Promise<LoadedNote> => {
    setFailedSource(null);
    try {
      return await requestNote(href, abortSignal);
    } catch (error) {
      if (!abortSignal.aborted) setFailedSource(href);
      throw error;
    }
  };

  const routeState = query.create<string, LoadedNote>({
    source: routeSource,
    initial: {
      source: initialHref,
      data: {
        source: initialHref,
        href: initialHref,
        props: initialEditorProps,
        eventDetail: initialDetail,
      },
    },
    load: (href, { abortSignal }) => loadNote(href, abortSignal),
  });
  const [showRouteLoading, setShowRouteLoading] = createSignal(false);
  createEffect(() => {
    if (!routeState.loading() && !routeState.refreshing()) {
      setShowRouteLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowRouteLoading(true), 150);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const loaded = routeState.data();
    if (loaded && routeSource() === loaded.source) {
      const applied = navigation.apply(loaded.source, loaded.href, () => {
        setCurrent(loaded.props);
        layout.update({
          breadcrumbs: [
            { title: t().start, href: "/" },
            { title: t().notebooks, href: "/app/notebooks" },
            { title: loaded.props.notebookName, href: `/app/notebooks/${props.notebookId}` },
            { title: loaded.props.noteTitle },
          ],
          title: loaded.props.noteTitle,
        });
        window.dispatchEvent(new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { ...loaded.eventDetail, href: loaded.href } }));
      });
      if (applied) return;
    }
    const failed = failedSource();
    if (routeState.error() && failed && routeSource() === failed) {
      navigation.fail(failed);
      return;
    }
  });

  /** `traversal`: Back or Forward already moved the history, so a cancel has to restore the shown note's address. */
  const navigateSoft = async (href: string, push: boolean, traversal = false): Promise<SoftNavigationResult> => {
    const target = resolveSameNotebookNoteTarget(href, window.location.href, props.notebookId);
    const mode = target ? requestedPresentationMode(new URL(target.canonicalHref, window.location.href).searchParams) : undefined;
    const keepsEditor = target && target.noteShortId === current().noteId && (!mode || mode === (props.readOnly ? "readonly" : "write"));
    const guard = keepsEditor ? undefined : leaveGuard;
    if (guard && !(await guard.confirmLeave())) {
      if (traversal && window.location.href !== shownHref) {
        // Without a history index, restoring the shown URL with pushState drops forward entries after it.
        window.history.pushState(window.history.state, "", shownHref);
        restoringShownHref = true;
        try {
          window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
        } finally {
          restoringShownHref = false;
        }
      }
      return { kind: "superseded" };
    }
    if (!target) return { kind: "fallback" };
    if (props.readOnly) {
      // Read-only opens another note with a page load; the open note stays, so a link to its heading opens in place.
      if (target.noteShortId !== current().noteId || (mode && mode !== "readonly")) return { kind: "fallback" };
    } else if (mode && mode !== "write") return { kind: "fallback" };
    if (guard) pendingGuardedNavigations++;
    const result = await navigation.navigate(target, push);
    if (guard) pendingGuardedNavigations--;
    if (result.kind === "applied") shownHref = new URL(result.href, window.location.href).href;
    else if (result.kind === "superseded" && pendingGuardedNavigations === 0) guard?.releaseLeave();
    return result;
  };

  onMount(() => {
    // Solid creates the editor and removes the preview in the same flush, before the next frame.
    document.getElementById(NOTE_PREVIEW_ID)?.remove();
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? anchor.href;
      const target = resolveSameNotebookNoteTarget(href, window.location.href, props.notebookId);
      if (!target) {
        // Anchors and non-editor routes still use document navigation, but
        // must not discard an explicitly selected presentation mode.
        const inherited = inheritPresentationMode(href, window.location.href);
        if (inherited !== href) {
          event.preventDefault();
          window.location.assign(inherited);
        }
        return;
      }
      event.preventDefault();
      void navigateSoft(href, true).then((result) => {
        if (result.kind === "fallback") window.location.assign(`${target.canonicalHref}${target.hash}`);
      });
    };

    const onPopState = () => {
      if (restoringShownHref) return;
      // A Back that lands on the address already shown, such as a closing sheet leaving its history entry, moves
      // nothing: no heading jump, no reload. A note still loading from an earlier Back is dropped, so the editor stays
      // with the address.
      if (window.location.href === shownHref) {
        navigation.cancel();
        return;
      }
      void navigateSoft(window.location.href, false, true).then((result) => {
        if (result.kind === "fallback") window.location.reload();
      });
    };

    const onFilterChanged = () => {
      shownHref = window.location.href;
    };

    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(SIDEBAR_FILTER_CHANGED_EVENT, onFilterChanged);
    onCleanup(
      registerSearchNavigation(async ({ href }) => {
        const target = inheritPresentationMode(href, window.location.href);
        const noteTarget = resolveSameNotebookNoteTarget(target, window.location.href, props.notebookId);
        const mode = requestedPresentationMode(new URL(target, window.location.href).searchParams);
        if (noteTarget && !props.readOnly && (!mode || mode === "write")) {
          const result = await navigateSoft(target, true);
          if (result.kind === "fallback") {
            // Search reports the failure and the note stays open, so a confirmed leave must not outlive it.
            leaveGuard?.releaseLeave();
            throw new Error("Note navigation failed");
          }
          return true;
        }
        if (target !== href) {
          window.location.assign(target);
          return true;
        }
        return false;
      }),
    );
    const offSoftRequests = handleSoftNoteNavigationRequests((href, options) => navigateSoft(href, options.push));
    onCleanup(() => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(SIDEBAR_FILTER_CHANGED_EVENT, onFilterChanged);
      offSoftRequests();
      navigation.dispose();
    });
  });

  return (
    <div class="relative flex-1 min-w-0 flex flex-col overflow-hidden">
      <Show when={current()} keyed>
        {(note) => {
          const startPosition = previewPosition;
          previewPosition = null;
          return (
            <EditorInstance {...note} linkedHeading={linkedHeading} startPosition={startPosition} registerLeaveGuard={registerLeaveGuard} />
          );
        }}
      </Show>
      <Show when={showRouteLoading()}>
        <div class="pointer-events-none absolute inset-0 z-30 flex items-start justify-center pt-4" aria-live="polite" aria-busy="true">
          <div class="inline-flex items-center gap-2 rounded-md bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm ring-1 ring-zinc-950/10 dark:bg-zinc-900/95 dark:text-zinc-200 dark:ring-white/10">
            <i class="ti ti-loader-2 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <span>{t().loadingNote}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

function EditorInstance(
  props: EditorInstanceProps & {
    linkedHeading: Accessor<LinkedHeading | null>;
    startPosition: ReadingPosition | null;
    registerLeaveGuard: (guard: LeaveGuard) => () => void;
  },
) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [connected, setConnected] = createSignal(false);
  const [historyIncomplete, setHistoryIncomplete] = createSignal(props.historyIncomplete);
  const [storageExhausted, setStorageExhausted] = createSignal(false);
  createEffect(() => {
    if (props.historyIncomplete) setHistoryIncomplete(true);
  });
  const [isDark, setIsDark] = createSignal(document.documentElement.classList.contains("dark"));
  const [richMode, setRichMode] = createSignal(props.initialRichMode !== "source");
  const syncEnded = createSyncEnded({
    messages: t,
    hasUnsentChanges: () => hasUnsentChanges(),
    resume: () => provider?.resume(),
    focusEditor: () => editorView()?.focus(),
  });
  // Edits the server has not confirmed yet, also those typed before the live note arrived, hold leaving until it does.
  const sentWaiters = new Set<() => void>();
  const notifySent = () => {
    if (hasUnsentChanges()) return;
    for (const resolve of sentWaiters) resolve();
    sentWaiters.clear();
  };
  onCleanup(
    props.registerLeaveGuard({
      confirmLeave: () => (holdsLeave() ? leaveAfterSent() : syncEnded.confirmLeave()),
      releaseLeave: syncEnded.releaseLeave,
    }),
  );
  // The sync-ended bar replaces the toolbar, so a toolbar mounted again starts from the panel's current state.
  const [panelOpen, setPanelOpen] = createSignal(props.initialPanelOpen);
  const onPanelState = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (detail && typeof detail === "object" && "isOpen" in detail && typeof detail.isOpen === "boolean") setPanelOpen(detail.isOpen);
  };
  const tabKeys = createTabKeyPreference(() => !!props.readOnly || !!syncEnded.ended());

  // The document stays empty until the first edit connects; the live state then arrives from the server, so the
  // saved text shown until then is never merged into it twice.
  const doc = new Y.Doc({ gc: true });
  const ytext = doc.getText("codemirror");
  /** The saved text the editor shows until the first edit; a newer save by someone else replaces it. */
  let baseText = (props.initialContent ?? "").replace(/\r\n?/g, "\n");
  const awareness = new Awareness(doc);

  const color = personColor(props.displayName);
  awareness.setLocalStateField("user", { userId: props.userId, name: props.displayName, color });

  const {
    ref: editorRef,
    createExtension: addExtension,
    editorView,
  } = createCodeMirror({
    value: baseText,
  });
  const comments = createEditorComments({
    notebookId: props.notebookId,
    noteId: props.noteId,
    me: { id: props.userId, name: props.displayName },
    canWrite: props.canWrite,
    editable: () => !props.readOnly && !syncEnded.ended(),
    readOnly: !!props.readOnly,
    initial: props.initialAnnotations,
    view: editorView,
  });
  addExtension(comments.extension);
  let commentsHost: HTMLDivElement | undefined;
  const [commentsExtent, setCommentsExtent] = createSignal(0);
  // With the detail panel open, comments show as dots beside the lines (the server renders the first state).
  createEffect(
    on(panelOpen, (open) => commentsHost?.closest(".notebook-document-surface")?.toggleAttribute("data-detail-open", open), {
      defer: true,
    }),
  );

  /** The note as the editor shows it; while collaboration runs, the editor mirrors Yjs. */
  const currentText = () => editorView()?.state.doc.toString() ?? baseText;

  // Book's rendering of the draft, or of the saved note in read-only mode: block previews and heading lines.
  const loadBlockPreview = async (markdown: string | undefined, abortSignal: AbortSignal, pages?: ReadonlyMap<number, number>) => {
    const json = {
      ...(markdown === undefined ? {} : { markdown }),
      ...(pages?.size ? { pages: Object.fromEntries([...pages].map(([line, page]) => [String(line), page])) } : {}),
    };
    const response = await apiClient[":id"].notes[":noteId"]["block-preview"].$post(
      { param: { id: props.notebookId, noteId: props.noteId }, json },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(queryBlockMessages.resolve([locale()]).t.failed);
    return response.json();
  };
  const blockPreviews = createQueryBlockPreviews({
    notebookId: props.notebookId,
    noteId: props.noteId,
    readOnly: !!props.readOnly,
    initialMarkdown: baseText,
    view: editorView,
    enabled: richMode,
    locale,
    load: (markdown, pages, abortSignal) => loadBlockPreview(markdown, abortSignal, pages),
  });
  addExtension(blockPreviews.listener);

  const undoManager = props.readOnly ? null : new Y.UndoManager(ytext);
  // The edits made before the live document arrived enter Yjs as one undo step.
  undoManager?.addTrackedOrigin(FIRST_EDITS);
  const collab = new Compartment();
  const [collabStarted, setCollabStarted] = createSignal(false);
  const [collabActive, setCollabActive] = createSignal(false);
  if (!props.readOnly && undoManager) {
    addExtension(collab.of([]));
    addExtension(() => isolateYjsHistory(undoManager));
    // The Yjs undo keys need the binding; before it, edits have no history to undo.
    addExtension(() => (syncEnded.ended() || !collabActive() ? [] : keymap.of(yUndoManagerKeymap)));
    // Reading or switching notes needs no collaboration; the first edit starts it.
    addExtension(
      EditorView.updateListener.of((update) => {
        if (collabStarted() || !update.docChanged || update.transactions.every((tr) => tr.annotation(firstEditsSettled))) return;
        setCollabStarted(true);
        syncState.start();
        // The typed words are unsent until the live note confirms them; leaving asks first.
        syncEnded.refresh();
        provider?.connect();
      }),
    );
  }
  const leaveAfterSent = async (): Promise<boolean> => {
    await Promise.race([
      new Promise<void>((resolve) => sentWaiters.add(resolve)),
      new Promise((resolve) => setTimeout(resolve, FIRST_EDITS_LEAVE_WAIT_MS)),
    ]);
    if (!holdsLeave()) return syncEnded.confirmLeave();
    const text = t();
    return (
      (await prompts.confirm(text.leaveUnsavedConfirm, {
        title: text.leaveNote,
        icon: "ti ti-logout",
        variant: "danger",
        confirmText: text.leaveNote,
      })) === true
    );
  };
  /** Edits typed before the live document arrived, which exist only on screen. */
  const pendingFirstEdits = () => collabStarted() && !collabActive();
  /** Edits not yet confirmed by the server, including those typed before the live document arrived. */
  const hasUnsentChanges = () => pendingFirstEdits() || (provider?.hasUnsentChanges() ?? false);
  /** Leaving waits only while this editor's own edits are on their way; an ended session has its own bar and prompt. */
  const holdsLeave = () => collabStarted() && !syncEnded.ended() && hasUnsentChanges();

  /**
   * Carries the edits made before the live document arrived onto it, writes them to Yjs and binds the editor to Yjs,
   * all in one task, so no remote update can reach Yjs in between.
   */
  const settleFirstEdits = () => {
    const view = editorView();
    if (!view || collabActive()) return;
    const edited = view.state.doc.toString();
    const live = ytext.toString();
    const rebased = rebaseOnto(baseText, edited, live);
    if (rebased) applyToYText(ytext, rebased.changes, FIRST_EDITS);
    const text = rebased?.text ?? live;
    if (text !== edited)
      view.dispatch({
        changes: changesBetween(edited, text) ?? { from: 0, to: edited.length, insert: text },
        annotations: [firstEditsSettled.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)],
      });
    // Someone rewrote the note while these first edits were typed: the live note stays, and the edits stay copyable.
    if (!rebased)
      toast(t().firstEditsNotMerged, {
        duration: 0,
        action: { label: t().copyFirstEdits, onClick: () => void clipboard.copy(edited) },
      });
    view.dispatch({ effects: collab.reconfigure([yCollab(ytext, null, { undoManager: undoManager! }), remoteCursors(ytext, awareness)]) });
    undoManager?.stopCapturing();
    setCollabActive(true);
    syncState.unsentChanged();
    syncEnded.refresh();
    notifySent();
  };

  let cursorIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorHiddenByIdle = false;

  const publishCurrentCursor = (view: EditorView) => {
    const selection = view.state.selection.main;
    awareness.setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
    });
    cursorHiddenByIdle = false;
  };

  const hideCursorForIdle = () => {
    awareness.setLocalStateField("cursor", null);
    cursorHiddenByIdle = true;
  };

  const scheduleCursorIdleHide = () => {
    if (cursorIdleTimer) {
      clearTimeout(cursorIdleTimer);
    }
    cursorIdleTimer = setTimeout(() => {
      hideCursorForIdle();
    }, CURSOR_IDLE_TIMEOUT_MS);
  };

  const markCursorActivity = (view?: EditorView) => {
    scheduleCursorIdleHide();
    if (cursorHiddenByIdle && view) {
      publishCurrentCursor(view);
    }
  };

  addExtension(
    EditorView.updateListener.of((update) => {
      if (!update.view.hasFocus) return;
      if (update.docChanged || update.selectionSet) {
        markCursorActivity(update.view);
      }
    }),
  );

  const linkedHeadingJump = createLinkedHeadingJump({
    noteId: props.noteId,
    linkedHeading: props.linkedHeading,
    view: editorView,
    loadHeadings: (abortSignal) => loadBlockPreview(props.readOnly ? undefined : currentText(), abortSignal),
    focus: !props.readOnly,
  });
  addExtension(linkedHeadingJump.extension);

  addExtension(editor.basicExtensions());
  // Custom formatting commands dispatch changes even in a read-only state.
  addExtension(() => (syncEnded.ended() ? [] : formattingKeymap({ notebookId: props.notebookId })));
  addExtension(() =>
    syncEnded.ended() ? [] : slashCommandsExtension({ notebookId: props.notebookId, notebookName: props.notebookName, locale: locale() }),
  );
  addExtension(editor.markdownExtension());
  addExtension(editor.searchTheme());
  let scrollPort: HTMLDivElement | undefined;
  addExtension(fadeScrollMarginsExtension(() => scrollPort));
  addExtension(() => (props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []));
  addExtension(syncEnded.extension);
  // Tab indents unless the person prefers focus movement; Esc, then Tab always leaves the editor.
  addExtension(tabKeys.extension);
  // List keys work whatever the Tab preference; toolbar formats follow the caret.
  const [format, setFormat] = createSignal(caretFormat(EditorState.create()), { equals: sameCaretFormat });
  addExtension(() =>
    props.readOnly
      ? []
      : [
          listCommandsExtension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
          }),
        ],
  );

  createEffect(() => {
    const view = editorView();
    if (view) setFormat(caretFormat(view.state));
  });

  addExtension(() => {
    if (richMode()) return isDark() ? editor.customDarkInit() : editor.customLightInit();
    return isDark() ? editor.rawDarkInit() : editor.rawLightInit();
  });

  addExtension(editor.noteScroller);

  addExtension(() => (richMode() ? [] : lineNumbers()));

  addExtension(() =>
    richMode()
      ? [
          editor.tablesExtension(props.notebookId),
          editor.imageExtension(props.notebookId),
          editor.listsExtension(),
          editor.infoBlocksExtension(locale()),
          editor.dataBlocksExtension(),
          blockPreviews.extension,
          editor.namedBlocksExtension(),
          editor.linksExtension(props.notebookId),
          editor.markupExtension(),
          editor.markExtension(),
          editor.subSupExtension(),
          editor.ligaturesExtension(),
          editor.initialMarkdownDecorationRefreshExtension(),
          editor.pointerSelectionMarkdownRefreshExtension(),
          editor.mermaidExtension(),
          editor.katexExtension(),
          editor.codeFontExtension(),
          editor.tagPillExtension(props.notebookId),
        ]
      : [],
  );

  const syncState = createSyncStateBridge({
    hasUnsentChanges: () => hasUnsentChanges(),
    emit: (detail) => {
      if (!props.readOnly) window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail }));
    },
  });
  const provider = props.readOnly
    ? null
    : yjs.createYjsProvider({
        doc,
        awareness,
        noteId: props.noteId,
        appUrl: props.appUrl,
        onConnectionChange: (value) => {
          setConnected(value);
          syncState.connectionChanged(value);
        },
        onHistoryIncomplete: () => setHistoryIncomplete(true),
        onError: (error) => {
          if (error.code === "STORAGE_EXHAUSTED") setStorageExhausted(true);
        },
        onReady: () => {
          settleFirstEdits();
          if (!provider?.hasUnsentChanges()) setStorageExhausted(false);
          syncState.ready();
          syncEnded.ready();
        },
        // Forwards every presence update to the OnlineSection island via a
        // window event — the editor itself doesn't need to track participants
        // anymore now that the toolbar no longer renders them.
        onPresenceChange: (next) => {
          window.dispatchEvent(new CustomEvent(PRESENCE_EVENT, { detail: next }));
        },
        onFatal: (error) => {
          syncState.end();
          syncEnded.end(error);
        },
        onUnsentChange: () => {
          if (!provider?.hasUnsentChanges()) setStorageExhausted(false);
          syncState.unsentChanged();
          syncEnded.refresh();
          notifySent();
        },
      });

  let disposed = false;
  let headingLines = extractHeadingLines(baseText);
  let panelFrame: number | undefined;
  let lastActiveHeading: string | null | undefined;
  let presencePending = false;
  let forcePresence = false;
  let lastPresence: string | undefined;
  const emitPanelLocations = () => {
    panelFrame = undefined;
    if (disposed) return;
    const view = editorView();
    if (view && scrollPort) {
      const height = Math.max(0, scrollPort.getBoundingClientRect().top + 8 - view.documentTop);
      const block = view.lineBlockAtHeight(height);
      const line = view.state.doc.lineAt(block.from).number;
      const id = headingAtLine(headingLines, line)?.id ?? null;
      if (id !== lastActiveHeading) {
        lastActiveHeading = id;
        window.dispatchEvent(new CustomEvent<ActiveHeadingEventDetail>(ACTIVE_HEADING_EVENT, { detail: { id } }));
      }
    }
    if (presencePending && view) {
      const detail = presenceLocations(
        participantCursors(awareness, ytext),
        (position) => view.state.doc.lineAt(Math.min(position, view.state.doc.length)).number,
        headingLines,
      );
      const serialized = JSON.stringify(Object.entries(detail).sort(([a], [b]) => a.localeCompare(b)));
      if (forcePresence || serialized !== lastPresence) {
        lastPresence = serialized;
        window.dispatchEvent(new CustomEvent(PRESENCE_LOCATIONS_EVENT, { detail }));
      }
      presencePending = false;
      forcePresence = false;
    }
    // Without a view yet, the request stays pending; the view's first geometry update sends it.
  };
  const schedulePanelLocations = () => {
    if (disposed) return;
    if (panelFrame === undefined) panelFrame = requestAnimationFrame(emitPanelLocations);
  };
  const schedulePresenceLocations = () => {
    presencePending = true;
    schedulePanelLocations();
  };
  awareness.on("change", schedulePresenceLocations);
  addExtension(
    EditorView.updateListener.of((update) => {
      if (update.geometryChanged || update.viewportChanged) schedulePanelLocations();
    }),
  );
  // A panel that mounts after the editor asks once for everything it mirrors, the text mode included.
  const onSyncStateRequest = () => {
    if (provider) syncState.request();
    window.dispatchEvent(new CustomEvent(RICH_MODE_CHANGED_EVENT, { detail: { isRich: richMode() } }));
    lastActiveHeading = undefined;
    forcePresence = true;
    schedulePresenceLocations();
  };
  const onReconnect = () => provider?.reconnectNow();
  const onJumpToParticipant = (event: Event) => {
    const detail = (event as CustomEvent<JumpToParticipantEventDetail>).detail;
    const view = editorView();
    if (!view || typeof detail?.userId !== "string") return;
    const position = participantCursors(awareness, ytext).get(detail.userId)?.position;
    if (position === null || position === undefined) return;
    view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "center" }) });
  };

  let themeObserver: MutationObserver | undefined;
  let tocDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingFocusFrames = new Set<number>();
  let lastDerivedTitle = props.noteTitle;

  // Both `emitToc` and the task-progress emitter share the same debounced
  // doc-change trigger, so we walk the markdown once and dispatch both
  // events in one pass. (TOC + tasks each parse cheaply, but doing it
  // twice would scan a large note twice per debounce tick.)
  const emitDerivedDocState = () => {
    const md = currentText();
    headingLines = extractHeadingLines(md);
    schedulePresenceLocations();
    const title = deriveNoteTitle(md);
    if (title !== lastDerivedTitle) {
      lastDerivedTitle = title;
      layout.update({
        breadcrumbs: [
          { title: t().start, href: "/" },
          { title: t().notebooks, href: "/app/notebooks" },
          { title: props.notebookName, href: `/app/notebooks/${props.notebookId}` },
          { title },
        ],
        title,
      });
      window.dispatchEvent(new CustomEvent(NOTE_TITLE_CHANGED_EVENT, { detail: { noteId: props.noteId, title } }));
    }
    // The headings parsed above are the outline too; a second parse would double the cost on long notes.
    window.dispatchEvent(new CustomEvent(TOC_UPDATE_EVENT, { detail: headingLines.map(({ line: _line, ...item }) => item) }));
    window.dispatchEvent(new CustomEvent(TASKS_UPDATE_EVENT, { detail: extractTaskProgress(md) }));
    window.dispatchEvent(new CustomEvent(ATTACHMENTS_UPDATE_EVENT, { detail: extractAttachmentIds(md) }));
    window.dispatchEvent(new CustomEvent(NAMED_BLOCKS_UPDATE_EVENT, { detail: extractNamedBlockSummaries(md) }));
  };

  const scheduleDerivedEmit = () => {
    if (tocDebounceTimer) clearTimeout(tocDebounceTimer);
    tocDebounceTimer = setTimeout(emitDerivedDocState, TOC_DEBOUNCE_MS);
  };

  // Typing only restarts the debounce; the heading index and the people's sections follow with the outline, so a
  // long note is not parsed again on every keystroke or remote update.
  const onTextUpdate = () => {
    scheduleDerivedEmit();
    printCopy?.changed();
  };
  // Local and remote edits both reach the editor's document, before and after collaboration starts.
  addExtension(
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onTextUpdate();
    }),
  );

  const onToggleRich = () =>
    setRichMode((value) => {
      const next = !value;
      writeSettings(props.notebookId, { richMode: next ? "rich" : "source" });
      return next;
    });

  // Broadcast richMode whenever it changes so the detail panel's "Markdown
  // source" / "Rich text mode" label can flip accordingly. Fires once on
  // hydration with the initial value, then on every toggle.
  createEffect(() => {
    window.dispatchEvent(new CustomEvent(RICH_MODE_CHANGED_EVENT, { detail: { isRich: richMode() } }));
  });

  const exportContent = () =>
    historyIncomplete() ? `> **${t().historyIncompleteTitle}** ${t().historyIncompleteDetail}\n\n${currentText()}` : currentText();

  let printArticle!: HTMLElement;
  let printCopy: ReturnType<typeof createNotePrintCopy> | undefined;
  createEffect(() => {
    historyIncomplete();
    locale();
    printCopy?.changed();
  });

  const onCopy = () => {
    void clipboard.copy(exportContent()).then(
      () => toast.success(t().contentCopied),
      () => toast.error(t().contentCopyFailed),
    );
  };

  const onDownload = () => {
    const filename = `${deriveNoteTitle(currentText())}.md`;
    files.downloadFileFromContent(exportContent(), filename, "text/markdown");
  };

  const onPdf = (event: Event) => {
    const detail = (event as CustomEvent<EditorPdfEventDetail>).detail;
    if (typeof detail?.open === "function") detail.open(exportContent());
  };

  const onScrollToHeading = (event: Event) => {
    const detail = (event as CustomEvent<{ id: string }>).detail;
    if (!detail?.id) return;
    const view = editorView();
    if (!view) return;

    // Against the document as it is now: the cached index may lag an edit by the debounce.
    const target = extractHeadingLines(view.state.doc.toString()).find((heading) => heading.id === detail.id);
    if (!target || target.line > view.state.doc.lines) return;
    const lineFrom = view.state.doc.line(target.line).from;
    view.dispatch({ selection: { anchor: lineFrom }, scrollIntoView: true });
  };

  const onScrollToNamedBlock = (event: Event) => {
    const detail = (event as CustomEvent<NamedBlockSummary>).detail;
    const view = editorView();
    if (!view || typeof detail?.line !== "number") return;

    const lineNumber = Math.min(Math.max(1, detail.line + 1), view.state.doc.lines);
    const lineFrom = view.state.doc.line(lineNumber).from;
    view.dispatch({ selection: { anchor: lineFrom }, scrollIntoView: true });
    view.focus();
  };

  const focusEditor = (attempts = 0, target: "start" | "end" = "start", scroll = true): boolean => {
    if (disposed) return false;
    const view = editorView();
    if (!view) {
      if (attempts < 8) {
        const frame = requestAnimationFrame(() => {
          pendingFocusFrames.delete(frame);
          focusEditor(attempts + 1, target, scroll);
        });
        pendingFocusFrames.add(frame);
      }
      return false;
    }

    const at = target === "end" ? view.state.doc.length : 0;
    view.dispatch({
      selection: { anchor: at },
      scrollIntoView: scroll,
    });
    view.focus();
    return true;
  };

  const selectInitialTitle = (attempts = 0): boolean => {
    if (disposed) return false;
    const view = editorView();
    if (!view) {
      if (attempts < 8) {
        const frame = requestAnimationFrame(() => {
          pendingFocusFrames.delete(frame);
          selectInitialTitle(attempts + 1);
        });
        pendingFocusFrames.add(frame);
      }
      return false;
    }
    const firstLine = view.state.doc.line(1);
    const marker = /^#\s+/.exec(firstLine.text);
    const from = firstLine.from + (marker?.[0].length ?? 0);
    view.dispatch({ selection: { anchor: from, head: firstLine.to }, scrollIntoView: true });
    view.focus();
    return true;
  };

  // ── Attachment upload pipeline ───────────────────────────────────────
  // Three trigger paths converge on the same `uploadAndInsert`:
  //   1. Picker modal (slash /file, footer button) — dispatches
  //      EDITOR_INSERT_ATTACHMENT_EVENT after upload-or-pick.
  //   2. Drag-drop anywhere on the note's workspace area.
  //   3. Paste of clipboard files (e.g. screenshots).
  const uploadFilesSequentially = async (fileList: File[]) => {
    const view = editorView();
    if (!view || fileList.length === 0) return;
    for (const file of fileList) {
      try {
        // Try to bring oversize images under the limit by scaling
        // their longer side. Returns null when no shrinking happened
        // (small enough already, non-image, or pipeline error) — we
        // upload the original and let the server enforce the limit.
        const shrunk = await maybeShrinkOversizeImage(file);
        const finalFile = shrunk ?? file;
        if (shrunk) {
          toast.success(
            t().imageResizedDescription({
              name: file.name,
              before: formatBytes(file.size),
              after: formatBytes(shrunk.size),
              limit: formatBytes(MAX_ATTACHMENT_SIZE_BYTES),
            }),
            { title: t().imageResized, iconClass: "ti ti-photo-edit" },
          );
        }
        await uploadAndInsert(view, props.notebookId, finalFile);
      } catch (error) {
        await prompts.error(error instanceof Error ? error.message : t().uploadFailed);
        return;
      }
    }
  };

  const onInsertAttachment = (event: Event) => {
    const view = editorView();
    const detail = (event as CustomEvent<AttachmentRef>).detail;
    if (view && detail) insertAttachment(view, detail);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (syncEnded.ended()) return;
    const fileList = Array.from(event.clipboardData?.files ?? []);
    if (fileList.length === 0) return;
    event.preventDefault();
    void uploadFilesSequentially(fileList);
  };

  onMount(() => {
    printCopy = createNotePrintCopy(printArticle, { notebookId: props.notebookId, noteId: props.noteId, markdown: exportContent, locale });
    writeSettings(props.notebookId, { lastNoteId: props.noteId });
    const opensHeading = linkedHeadingJump.open();
    const startPosition = props.startPosition;
    if (startPosition) {
      // The editor view arrives later in this flush; the microtask still runs before the next paint.
      queueMicrotask(() => {
        const view = editorView();
        if (view && scrollPort) scrollToReadingPosition(view, scrollPort, startPosition);
      });
    }
    if (!props.readOnly) {
      if (consumeInitialTitleSelection(props.noteId)) selectInitialTitle();
      // A reader who scrolled the preview keeps reading there; the caret still starts the note.
      else if (!opensHeading) focusEditor(0, "start", !startPosition);
      scheduleCursorIdleHide();
    }
    // First emit so the panel reflects the current doc immediately on mount,
    // not only after the first keystroke.
    emitDerivedDocState();
    schedulePanelLocations();
    scrollPort?.addEventListener("scroll", schedulePanelLocations, { passive: true });
    window.addEventListener(SYNC_STATE_REQUEST_EVENT, onSyncStateRequest);
    window.addEventListener(RECONNECT_EVENT, onReconnect);
    window.addEventListener(JUMP_TO_PARTICIPANT_EVENT, onJumpToParticipant);

    // Showing or hiding the navigation rewraps the note; the same text stays at the top.
    let restoreReadingPosition: (() => void) | null = null;
    const onNavigationWillChange = () => {
      const view = editorView();
      restoreReadingPosition = view && scrollPort ? keepReadingPosition(view, scrollPort) : null;
    };
    const onNavigationChanged = () => {
      const restore = restoreReadingPosition;
      restoreReadingPosition = null;
      // After every listener of this event, so the navigation has already changed.
      if (restore) queueMicrotask(restore);
    };
    // Hiding the navigation while a tree row had focus hands focus to the note, with its caret.
    const onNavigationFocusLost = (event: Event) => {
      const view = editorView();
      if (!view || props.readOnly) return;
      event.preventDefault();
      view.focus();
    };
    window.addEventListener(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT, onNavigationWillChange);
    window.addEventListener(NAVIGATION_VISIBILITY_EVENT, onNavigationChanged);
    window.addEventListener(NAVIGATION_FOCUS_EVENT, onNavigationFocusLost);
    onCleanup(() => {
      window.removeEventListener(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT, onNavigationWillChange);
      window.removeEventListener(NAVIGATION_VISIBILITY_EVENT, onNavigationChanged);
      window.removeEventListener(NAVIGATION_FOCUS_EVENT, onNavigationFocusLost);
    });

    if (scrollPort) {
      followFullWidth(
        scrollPort,
        () => {
          const view = editorView();
          return view && scrollPort ? keepReadingPosition(view, scrollPort) : null;
        },
        t,
      );
    }

    // Before the first edit nothing is live: a save by someone else reaches this note as its new saved text.
    let savedTextRequest: AbortController | undefined;
    const readSavedText = async (request: AbortController, attempt = 0): Promise<void> => {
      try {
        const response = await apiClient[":id"]["route-state"].$get(
          { param: { id: props.notebookId }, query: { href: window.location.pathname + window.location.search } },
          { init: { signal: request.signal } },
        );
        if (!response.ok) throw new Error(`Failed to load the saved note (${response.status})`);
        const payload = await response.json();
        const view = editorView();
        if (request.signal.aborted || collabStarted() || !view) return;
        // A note locked, deleted or moved out of reach meanwhile reopens as the server now shows it.
        if (payload.kind !== "ok" || payload.state.note.id !== props.noteId) {
          window.location.reload();
          return;
        }
        if (payload.state.note.historyIncomplete) setHistoryIncomplete(true);
        const saved = (payload.state.note.contentMd ?? "").replace(/\r\n?/g, "\n");
        const shown = view.state.doc.toString();
        baseText = saved;
        if (saved !== shown)
          view.dispatch({
            changes: changesBetween(shown, saved) ?? { from: 0, to: shown.length, insert: saved },
            annotations: [firstEditsSettled.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)],
          });
      } catch (error) {
        if (request.signal.aborted) return;
        // A later event may move the live cursor past this one, so the note tries again on its own.
        if (attempt >= SAVED_TEXT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        return readSavedText(request, attempt + 1);
      }
    };
    const onWorkspaceEvent = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
      const { event } = detail;
      if (props.readOnly || collabStarted()) return;
      // A note deleted elsewhere before anyone typed here reopens as the server now shows it.
      if (event.type === "note.deleted" && event.noteId === props.noteId) {
        window.location.reload();
        return;
      }
      if (event.type !== "note.updated" || event.note.id !== props.noteId) return;
      if (event.note.historyIncomplete) setHistoryIncomplete(true);
      savedTextRequest?.abort();
      const request = new AbortController();
      savedTextRequest = request;
      // The event counts as seen only once the saved text arrived, so a failed read is not skipped for good.
      detail.cover(readSavedText(request));
    };
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    onCleanup(() => {
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      savedTextRequest?.abort();
    });
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!holdsLeave()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
    window.addEventListener(TOC_SCROLL_EVENT, onScrollToHeading);
    window.addEventListener(NAMED_BLOCK_SCROLL_EVENT, onScrollToNamedBlock);
    window.addEventListener(TOGGLE_RICH_MODE_EVENT, onToggleRich);
    window.addEventListener(EDITOR_COPY_EVENT, onCopy);
    window.addEventListener(EDITOR_DOWNLOAD_EVENT, onDownload);
    window.addEventListener(EDITOR_PDF_EVENT, onPdf);
    window.addEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsertAttachment);
    window.addEventListener(DETAIL_PANEL_STATE_EVENT, onPanelState);

    themeObserver = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });

    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  });

  onCleanup(() => {
    disposed = true;
    printCopy?.dispose();
    syncState.dispose();
    if (panelFrame !== undefined) cancelAnimationFrame(panelFrame);
    awareness.off("change", schedulePresenceLocations);
    scrollPort?.removeEventListener("scroll", schedulePanelLocations);
    window.removeEventListener(SYNC_STATE_REQUEST_EVENT, onSyncStateRequest);
    window.removeEventListener(RECONNECT_EVENT, onReconnect);
    window.removeEventListener(JUMP_TO_PARTICIPANT_EVENT, onJumpToParticipant);
    for (const frame of pendingFocusFrames) cancelAnimationFrame(frame);
    pendingFocusFrames.clear();
    if (cursorIdleTimer) {
      clearTimeout(cursorIdleTimer);
    }
    if (tocDebounceTimer) {
      clearTimeout(tocDebounceTimer);
    }
    window.removeEventListener(TOC_SCROLL_EVENT, onScrollToHeading);
    window.removeEventListener(NAMED_BLOCK_SCROLL_EVENT, onScrollToNamedBlock);
    window.removeEventListener(TOGGLE_RICH_MODE_EVENT, onToggleRich);
    window.removeEventListener(EDITOR_COPY_EVENT, onCopy);
    window.removeEventListener(EDITOR_DOWNLOAD_EVENT, onDownload);
    window.removeEventListener(EDITOR_PDF_EVENT, onPdf);
    window.removeEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsertAttachment);
    window.removeEventListener(DETAIL_PANEL_STATE_EVENT, onPanelState);
    themeObserver?.disconnect();
    provider?.dispose();
    undoManager?.destroy();
    awareness.destroy();
    doc.destroy();
  });

  return (
    <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
      <article ref={printArticle} class="notebook-book-content notebook-note-print" />
      {/* Once retries stop, the sync-ended bar owns the message; this notice promises retries. */}
      <Show when={storageExhausted() && !syncEnded.ended()}>
        <NoticeCard role="alert" tone="danger" title={t().storageExhaustedTitle} detail={t().storageExhaustedDetail} />
      </Show>
      <Show when={historyIncomplete()}>
        <NoticeCard role="status" tone="warning" title={t().historyIncompleteTitle} detail={t().historyIncompleteDetail} />
      </Show>
      <ScrollArea
        ref={scrollPort}
        style={{ "scroll-padding-block": fadeScrollPadding }}
        class="relative min-h-0 flex-1 cursor-text"
        onMouseDown={(event) => {
          if (props.readOnly || !pressMissedEditor(event)) return;
          event.preventDefault();
          if (focusEditor(0, "end")) {
            const view = editorView();
            if (view) {
              markCursorActivity(view);
            }
          }
        }}
        onMouseMove={() => {
          const view = editorView();
          if (view?.hasFocus) {
            scheduleCursorIdleHide();
          }
        }}
        onKeyDown={() => {
          const view = editorView();
          if (view?.hasFocus) {
            scheduleCursorIdleHide();
          }
        }}
        onPaste={props.readOnly ? undefined : onPaste}
        role="textbox"
        tabIndex={-1}
        aria-label={props.readOnly || syncEnded.ended() ? t().readonlySurface : t().editorSurface}
      >
        <div ref={commentsHost} class="notebook-comments-host" style={{ "min-height": `${commentsExtent()}px` }}>
          <div ref={editorRef} />
          {comments.margin(
            () => commentsHost,
            () => commentsHost?.closest<HTMLElement>(".notebook-document-surface") ?? undefined,
            setCommentsExtent,
          )}
        </div>
      </ScrollArea>
      {comments.toolbar(() => scrollPort)}
      {/* Files dropped anywhere on the note's page upload and land at the cursor. */}
      <FileDropTarget
        label={t().dropToInsert}
        disabled={props.readOnly || !!syncEnded.ended()}
        onDrop={(fileList) => void uploadFilesSequentially(fileList)}
      />
      <Show when={tabKeys.indents()}>
        <p id={tabKeys.hintId} class="sr-only">
          {t().tabIndentHint}
        </p>
      </Show>
      <Show when={!props.readOnly}>
        <Show
          when={syncEnded.ended()}
          fallback={
            <EditorToolbar
              connected={!collabStarted() || connected()}
              editorView={editorView()}
              notebookId={props.notebookId}
              noteId={props.noteId}
              initialPanelOpen={panelOpen()}
              format={format()}
              onUndo={() => undoManager?.undo()}
              onRedo={() => undoManager?.redo()}
              comments={{ open: comments.openCount(), onOpen: comments.ui.requestList }}
            />
          }
        >
          {(ended) => (
            <SyncEndedBar
              notebookId={props.notebookId}
              ended={ended()}
              sync={syncEnded}
              markdown={currentText}
              noteHref={() => window.location.pathname + window.location.search}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}
