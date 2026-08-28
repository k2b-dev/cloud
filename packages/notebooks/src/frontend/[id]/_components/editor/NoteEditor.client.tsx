import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { encoding } from "@k2b/stdlib";
import { clipboard, files } from "@k2b/stdlib/browser";
import { dropzone, query } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { layout } from "@valentinkolb/cloud/ssr/layout-runtime";
import { createCodeMirror } from "solid-codemirror";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { apiClient } from "@/api/client";
import { extractNamedBlockSummaries, type NamedBlockSummary } from "../../../../lib/named-blocks";
import { hasOnlyNavigatorQuery } from "../../../../lib/navigator-url";
import { deriveNoteTitle } from "../../../../lib/note-title";
import type { Backlink } from "../../../../service/links";
import { editor } from "../../../lib/editor";
import { extractAttachmentIds } from "../../../lib/editor/attachment-url";
import { consumeInitialTitleSelection, handleSoftNoteNavigationRequests, type SoftNavigationResult } from "../../../lib/soft-navigation";
import { getNotebookPresenceColor, yjs } from "../../../lib/yjs";
import {
  ATTACHMENTS_UPDATE_EVENT,
  EDITOR_COPY_EVENT,
  EDITOR_DOWNLOAD_EVENT,
  EDITOR_PDF_EVENT,
  type EditorPdfEventDetail,
  EDITOR_INSERT_ATTACHMENT_EVENT,
  NAMED_BLOCK_SCROLL_EVENT,
  NAMED_BLOCKS_UPDATE_EVENT,
  NOTE_SOFT_NAVIGATED_EVENT,
  NOTE_TITLE_CHANGED_EVENT,
  PRESENCE_EVENT,
  RICH_MODE_CHANGED_EVENT,
  TASKS_UPDATE_EVENT,
  TOC_SCROLL_EVENT,
  TOC_UPDATE_EVENT,
  TOGGLE_RICH_MODE_EVENT,
} from "../detail/events";
import { extractTaskProgress } from "../detail/tasks";
import { extractTocFromMarkdown } from "../detail/toc";
import { writeSettings } from "../settings/NotebookSettingsStore";
import { dispatchWorkspaceEvent } from "../sidebar/workspace-events";
import type { Attachment, AttachmentRef } from "./attachments-client";
import { formatBytes, insertAttachment, MAX_ATTACHMENT_SIZE_BYTES, maybeShrinkOversizeImage, uploadAndInsert } from "./attachments-client";
import EditorToolbar, { formattingKeymap } from "./EditorToolbar";
import { createNoteNavigationCoordinator } from "./note-navigation";
import { slashCommandsExtension } from "./slash-commands";
import { notebookWorkspaceMessages } from "../../messages";

const TOC_DEBOUNCE_MS = 300;
type EditorInstanceProps = {
  noteId: string;
  noteTitle: string;
  notebookId: string;
  /** Per-notebook opt-in flag for the JS scripting feature. When true,
   *  fenced ` ```script ` blocks evaluate in the editor; when false,
   *  they render as inert code-fences. Toggled in NotebookSettingsPanel. */
  scriptsEnabled: boolean;
  // ---- script-kit metadata snapshot (Phase 2 kit.note read-only fields)
  // These mirror the SSR-rendered `selectedNote` / `notebook` shapes
  // and feed `kit.note.*` getters for fields that don't live in the
  // Y.Doc itself. The Y.Text content is the live source for body /
  // tags / tasks; everything else (title, timestamps, lockedAt,
  // parentId, notebookName) updates only on full page render.
  noteCreatedAt: string;
  noteUpdatedAt: string;
  noteLockedAt: string | null;
  noteParentId: string | null;
  notebookName: string;
  // ---- end script-kit metadata
  appUrl: string;
  workspaceCursor: string | null;
  onWorkspaceCursorChange?: (cursor: string) => void;
  userId: string;
  displayName: string;
  initialSnapshot: string | null;
  initialContent?: string | null;
  initialPanelOpen: boolean;
  initialRichMode: "rich" | "source";
  readOnly?: boolean;
};

const CURSOR_IDLE_TIMEOUT_MS = 8_000;

type SoftNavigatedDetail = {
  noteId: string;
  noteTitle: string;
  contentMd: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
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

type SameNotebookNoteHref = {
  noteShortId: string;
  canonicalHref: string;
};

const parseSameNotebookEditNoteUrl = (href: string, notebookId: string): SameNotebookNoteHref | null => {
  const noteSchemeMatch = href.match(/^note:\/\/([0-9a-zA-Z]{6})$/);
  if (noteSchemeMatch?.[1]) {
    const noteShortId = noteSchemeMatch[1];
    return {
      noteShortId,
      canonicalHref: `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${encodeURIComponent(noteShortId)}`,
    };
  }

  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || url.hash || !hasOnlyNavigatorQuery(url.searchParams)) return null;
    const match = url.pathname.match(/^\/app\/notebooks\/([^/]+)\/notes\/([^/]+)$/);
    if (!match || match[1] !== notebookId) return null;
    const noteShortId = decodeURIComponent(match[2]!);
    if (!/^[0-9A-Za-z]{6}$/.test(noteShortId)) return null;
    return {
      noteShortId,
      canonicalHref: `${url.pathname}${url.search}`,
    };
  } catch {
    return null;
  }
};

export default function NoteEditor(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const { initialHref, initialDetail, ...initialEditorProps } = props;
  const [lastWorkspaceCursor, setLastWorkspaceCursor] = createSignal(initialEditorProps.workspaceCursor);
  const [current, setCurrent] = createSignal<EditorInstanceProps>({
    ...initialEditorProps,
    onWorkspaceCursorChange: setLastWorkspaceCursor,
  });
  const [routeSource, setRouteSource] = createSignal(initialHref);
  const [failedSource, setFailedSource] = createSignal<string | null>(null);
  const navigation = createNoteNavigationCoordinator({
    initialSource: initialHref,
    currentNoteShortId: () => current().noteId,
    currentHref: () => `${window.location.pathname}${window.location.search}`,
    setSource: setRouteSource,
    pushHistory: (href) => window.history.pushState({}, "", href),
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
        noteCreatedAt: note.createdAt,
        noteUpdatedAt: note.updatedAt,
        noteLockedAt: note.lockedAt,
        noteParentId: note.parentId,
        initialSnapshot: note.yjsSnapshot,
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
        setCurrent({
          ...loaded.props,
          workspaceCursor: lastWorkspaceCursor(),
          onWorkspaceCursorChange: setLastWorkspaceCursor,
        });
        layout.update({
          breadcrumbs: [
            { title: t().start, href: "/" },
            { title: t().notebooks, href: "/app/notebooks" },
            { title: loaded.props.notebookName, href: `/app/notebooks/${props.notebookId}` },
            { title: loaded.props.noteTitle },
          ],
          title: loaded.props.noteTitle,
        });
        window.dispatchEvent(new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: loaded.eventDetail }));
      });
      if (applied) return;
    }
    const failed = failedSource();
    if (routeState.error() && failed && routeSource() === failed) {
      navigation.fail(failed);
      return;
    }
  });

  const navigateSoft = async (href: string, push: boolean): Promise<SoftNavigationResult> => {
    const target = parseSameNotebookEditNoteUrl(href, props.notebookId);
    if (!target) return { kind: "fallback" };
    return await navigation.navigate(target, push);
  };

  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? anchor.href;
      const target = parseSameNotebookEditNoteUrl(href, props.notebookId);
      if (!target) return;
      event.preventDefault();
      void navigateSoft(href, true).then((result) => {
        if (result.kind === "fallback") window.location.assign(target.canonicalHref);
      });
    };

    const onPopState = () => {
      void navigateSoft(window.location.href, false).then((result) => {
        if (result.kind === "fallback") window.location.reload();
      });
    };

    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPopState);
    const offSoftRequests = handleSoftNoteNavigationRequests((href, options) => navigateSoft(href, options.push));
    onCleanup(() => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPopState);
      offSoftRequests();
      navigation.dispose();
    });
  });

  return (
    <div class="relative flex-1 min-w-0 flex flex-col overflow-hidden">
      <Show when={current()} keyed>
        {(note) => <EditorInstance {...note} />}
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

function EditorInstance(props: EditorInstanceProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [connected, setConnected] = createSignal(false);
  const [isDark, setIsDark] = createSignal(document.documentElement.classList.contains("dark"));
  const [richMode, setRichMode] = createSignal(props.initialRichMode !== "source");

  const doc = new Y.Doc({ gc: true });
  if (props.initialSnapshot) {
    const bytes = encoding.fromBase64(props.initialSnapshot);
    if (bytes.length) Y.applyUpdate(doc, bytes, "initial");
  }

  const ytext = doc.getText("codemirror");
  if (props.readOnly && !props.initialSnapshot && props.initialContent) {
    ytext.insert(0, props.initialContent);
  }
  const awareness = new Awareness(doc);

  const color = getNotebookPresenceColor(props.userId);
  awareness.setLocalStateField("user", { name: props.displayName, color });

  const {
    ref: editorRef,
    createExtension: addExtension,
    editorView,
  } = createCodeMirror({
    value: ytext.toString(),
  });

  const undoManager = props.readOnly ? null : new Y.UndoManager(ytext);
  if (!props.readOnly && undoManager) {
    addExtension(() => yCollab(ytext, awareness, { undoManager }));
    addExtension(() => keymap.of(yUndoManagerKeymap));
  }

  let cursorIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorHiddenByIdle = false;
  let fatalPromptOpen = false;

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

  addExtension(editor.basicExtensions());
  addExtension(formattingKeymap({ notebookId: props.notebookId }));
  addExtension(slashCommandsExtension({ notebookId: props.notebookId, locale: locale() }));
  addExtension(editor.markdownExtension());
  addExtension(editor.searchTheme());
  addExtension(() => (props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []));

  addExtension(() => {
    if (richMode()) return isDark() ? editor.customDarkInit() : editor.customLightInit();
    return isDark() ? editor.rawDarkInit() : editor.rawLightInit();
  });

  addExtension(
    EditorView.theme({
      ".cm-editor": { minHeight: "100%" },
      ".cm-scroller": { width: "100%", minHeight: "100%", padding: "1rem" },
    }),
  );

  addExtension(() => (richMode() ? [] : lineNumbers()));

  addExtension(() =>
    richMode()
      ? [
          editor.tablesExtension(props.notebookId),
          editor.imageExtension(props.notebookId),
          editor.listsExtension(),
          editor.infoBlocksExtension(),
          editor.dataBlocksExtension(),
          editor.namedBlocksExtension(),
          editor.linksExtension(props.notebookId),
          editor.markupExtension(),
          editor.markExtension(),
          editor.subSupExtension(),
          editor.initialMarkdownDecorationRefreshExtension(),
          editor.pointerSelectionMarkdownRefreshExtension(),
          editor.mermaidExtension(),
          editor.katexExtension(),
          editor.codeFontExtension(),
          editor.tagPillExtension(props.notebookId),
          // Note: `kit.*` autocomplete is wired INSIDE the
          // slashCommandsExtension's `override` array (both kit and
          // slash sources share one `autocompletion()` config so
          // they can coexist — override means CM only uses sources
          // we explicitly list).
          // Scripts: per-notebook opt-in (admin toggles in settings).
          // When OFF the extension emits no widgets and the
          // ```script fence renders as a plain code block. When ON
          // each block gets a `.md-script-output` block widget below
          // it, hosting kit UI (buttons, toasts, error blocks). The
          // widget root sets `contenteditable=false` so CM6's
          // MutationObserver skips the subtree — without that, the
          // kit's runtime DOM mutations get misinterpreted as user
          // edits and corrupt the script body / surrounding doc.
          editor.scriptsExtension({
            scriptsEnabled: () => props.scriptsEnabled,
            readOnly: () => !!props.readOnly,
            notebookId: props.notebookId,
            noteSnapshot: () => ({
              id: props.noteId,
              title: deriveNoteTitle(ytext.toString()),
              // Live content snapshot — kit's `note.content` getter
              // re-reads ytext on every access, but the snapshot
              // here covers any code path that bypasses the getter.
              content: ytext.toString(),
              notebookName: props.notebookName,
              parentId: props.noteParentId,
              createdAt: props.noteCreatedAt,
              updatedAt: props.noteUpdatedAt,
              lockedAt: props.noteLockedAt,
            }),
            ytext,
            ydoc: doc,
          }),
        ]
      : [],
  );

  const provider = props.readOnly
    ? null
    : yjs.createYjsProvider({
        doc,
        awareness,
        noteId: props.noteId,
        appUrl: props.appUrl,
        onConnectionChange: setConnected,
        // Forwards every presence update to the OnlineSection island via a
        // window event — the editor itself doesn't need to track participants
        // anymore now that the toolbar no longer renders them.
        onPresenceChange: (next) => {
          window.dispatchEvent(new CustomEvent(PRESENCE_EVENT, { detail: next }));
        },
        workspace: {
          notebookId: props.notebookId,
          initialCursor: props.workspaceCursor,
          onEvent: dispatchWorkspaceEvent,
          onCursorChange: props.onWorkspaceCursorChange,
        },
        onFatal: (error) => {
          if (fatalPromptOpen) return;
          fatalPromptOpen = true;
          const isLocked = error.code === "NOTE_LOCKED";
          const isMissing = error.code === "NOTE_NOT_FOUND";
          const isRevoked = error.code === "ACCESS_REVOKED" || error.code === "ACCESS_DENIED";
          const isSession = error.code === "SESSION_EXPIRED" || error.code === "LOGIN_REQUIRED";

          const title = isLocked
            ? t().noteLocked
            : isMissing
              ? t().noteNotFound
              : isRevoked
                ? t().accessChanged
                : isSession
                  ? t().sessionExpired
                  : t().connectionClosed;

          const icon = isLocked
            ? "ti ti-lock"
            : isMissing
              ? "ti ti-file-x"
              : isRevoked
                ? "ti ti-shield-off"
                : isSession
                  ? "ti ti-login-2"
                  : "ti ti-alert-triangle";

          const message = isLocked
            ? t().noteLockedDescription
            : isMissing
              ? t().noteMissingDescription
              : isRevoked
                ? t().accessChangedDescription
                : isSession
                  ? t().sessionExpiredDescription
                  : t().connectionClosedDescription;

          void prompts
            .alert(t().reloadNotice({ message }), {
              title,
              icon,
            })
            .finally(() => {
              refreshCurrentPath();
            });
        },
      });

  let themeObserver: MutationObserver | undefined;
  let tocDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingFocusFrames = new Set<number>();
  let disposed = false;
  let lastDerivedTitle = props.noteTitle;

  // Both `emitToc` and the task-progress emitter share the same debounced
  // doc-change trigger, so we walk the markdown once and dispatch both
  // events in one pass. (TOC + tasks each parse cheaply, but doing it
  // twice would scan a large note twice per debounce tick.)
  const emitDerivedDocState = () => {
    const md = ytext.toString();
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
    window.dispatchEvent(new CustomEvent(TOC_UPDATE_EVENT, { detail: extractTocFromMarkdown(md) }));
    window.dispatchEvent(new CustomEvent(TASKS_UPDATE_EVENT, { detail: extractTaskProgress(md) }));
    window.dispatchEvent(new CustomEvent(ATTACHMENTS_UPDATE_EVENT, { detail: extractAttachmentIds(md) }));
    window.dispatchEvent(new CustomEvent(NAMED_BLOCKS_UPDATE_EVENT, { detail: extractNamedBlockSummaries(md) }));
  };

  const scheduleDerivedEmit = () => {
    if (tocDebounceTimer) clearTimeout(tocDebounceTimer);
    tocDebounceTimer = setTimeout(emitDerivedDocState, TOC_DEBOUNCE_MS);
  };

  const onTextUpdate = () => scheduleDerivedEmit();
  ytext.observe(onTextUpdate);

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

  const onCopy = () => {
    void clipboard.copy(ytext.toString()).then(
      () => toast.success(t().contentCopied),
      () => toast.error(t().contentCopyFailed),
    );
  };

  const onDownload = () => {
    const filename = `${deriveNoteTitle(ytext.toString())}.md`;
    files.downloadFileFromContent(ytext.toString(), filename, "text/markdown");
  };

  const onPdf = (event: Event) => {
    const detail = (event as CustomEvent<EditorPdfEventDetail>).detail;
    if (typeof detail?.open === "function") detail.open(ytext.toString());
  };

  const onScrollToHeading = (event: Event) => {
    const detail = (event as CustomEvent<{ id: string }>).detail;
    if (!detail?.id) return;
    const view = editorView();
    if (!view) return;

    // Re-extract from the current doc and match by id (slug). This stays
    // correct even if the user has edited since the TOC was last emitted.
    const items = extractTocFromMarkdown(ytext.toString());
    const target = items.find((item) => item.id === detail.id);
    if (!target) return;

    // Find the heading line by linear scan of the doc — slug ordering matches
    // document order, so we count how many headings precede our target and
    // pick the Nth heading-line in the doc.
    const targetIndex = items.indexOf(target);
    let seenHeadings = 0;
    let lineNumber = 1;
    const totalLines = view.state.doc.lines;
    for (let i = 1; i <= totalLines; i++) {
      const text = view.state.doc.line(i).text;
      if (/^#{1,6}\s+/.test(text)) {
        if (seenHeadings === targetIndex) {
          lineNumber = i;
          break;
        }
        seenHeadings++;
      }
    }
    const lineFrom = view.state.doc.line(lineNumber).from;
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

  const focusEditor = (attempts = 0, target: "start" | "end" = "start"): boolean => {
    if (disposed) return false;
    const view = editorView();
    if (!view) {
      if (attempts < 8) {
        const frame = requestAnimationFrame(() => {
          pendingFocusFrames.delete(frame);
          focusEditor(attempts + 1, target);
        });
        pendingFocusFrames.add(frame);
      }
      return false;
    }

    const at = target === "end" ? view.state.doc.length : 0;
    view.dispatch({
      selection: { anchor: at },
      scrollIntoView: true,
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
  //   2. Drag-drop on the editor wrapper.
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
    const fileList = Array.from(event.clipboardData?.files ?? []);
    if (fileList.length === 0) return;
    event.preventDefault();
    void uploadFilesSequentially(fileList);
  };

  const dz = dropzone.create({ onDrop: (fileList) => void uploadFilesSequentially(fileList) });

  onMount(() => {
    writeSettings(props.notebookId, { lastNoteId: props.noteId });
    provider?.connect();
    if (!props.readOnly) {
      if (consumeInitialTitleSelection(props.noteId)) selectInitialTitle();
      else focusEditor();
      scheduleCursorIdleHide();
    }
    // First emit so the panel reflects the current doc immediately on mount,
    // not only after the first keystroke.
    emitDerivedDocState();

    window.addEventListener(TOC_SCROLL_EVENT, onScrollToHeading);
    window.addEventListener(NAMED_BLOCK_SCROLL_EVENT, onScrollToNamedBlock);
    window.addEventListener(TOGGLE_RICH_MODE_EVENT, onToggleRich);
    window.addEventListener(EDITOR_COPY_EVENT, onCopy);
    window.addEventListener(EDITOR_DOWNLOAD_EVENT, onDownload);
    window.addEventListener(EDITOR_PDF_EVENT, onPdf);
    window.addEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsertAttachment);

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
    for (const frame of pendingFocusFrames) cancelAnimationFrame(frame);
    pendingFocusFrames.clear();
    if (cursorIdleTimer) {
      clearTimeout(cursorIdleTimer);
    }
    if (tocDebounceTimer) {
      clearTimeout(tocDebounceTimer);
    }
    ytext.unobserve(onTextUpdate);
    window.removeEventListener(TOC_SCROLL_EVENT, onScrollToHeading);
    window.removeEventListener(NAMED_BLOCK_SCROLL_EVENT, onScrollToNamedBlock);
    window.removeEventListener(TOGGLE_RICH_MODE_EVENT, onToggleRich);
    window.removeEventListener(EDITOR_COPY_EVENT, onCopy);
    window.removeEventListener(EDITOR_DOWNLOAD_EVENT, onDownload);
    window.removeEventListener(EDITOR_PDF_EVENT, onPdf);
    window.removeEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsertAttachment);
    themeObserver?.disconnect();
    provider?.dispose();
    undoManager?.destroy();
    awareness.destroy();
    doc.destroy();
  });

  return (
    <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
      <div
        class={`relative min-h-0 flex-1 cursor-text overflow-y-auto transition-colors ${
          !props.readOnly && dz.isDragging() ? "ring-2 ring-blue-400 dark:ring-blue-500 ring-inset" : ""
        }`}
        onMouseDown={(event) => {
          if (props.readOnly) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest(".cm-editor")) return;
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
        {...(props.readOnly ? {} : dz.handlers)}
        role="textbox"
        tabIndex={-1}
        aria-label={props.readOnly ? t().readonlySurface : t().editorSurface}
      >
        <div ref={editorRef} />
      </div>
      <Show when={!props.readOnly}>
        <EditorToolbar
          connected={connected()}
          editorView={editorView()}
          notebookId={props.notebookId}
          initialPanelOpen={props.initialPanelOpen}
        />
      </Show>
    </div>
  );
}
