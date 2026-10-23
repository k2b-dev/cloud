/**
 * The Notebook editor composition from NoteEditor.client.tsx around the shared
 * @k2b/ui TextEditor, with an in-page server and a second person instead of
 * the WebSocket provider. Keep the extension list in step with NoteEditor.
 */

import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { createSharedTextActionHistory } from "@k2b/cloud/browser/shared-text";
import { encoding } from "@k2b/stdlib";
import { Button, LocaleProvider, NoticeCard, ScrollArea } from "@k2b/ui";
import { TextEditor, type TextEditorControls } from "@k2b/ui/text-editor";
import { createSignal, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { NoteTableActionRequest } from "../../../../lib/table-actions";
import { editor } from "../../../lib/editor";
import { listCommandsExtension } from "../../../lib/editor/list-commands";
import { remoteCursors } from "../../../lib/editor/remote-cursors";
import {
  caretIntoTableCell,
  cellFormattingKeys,
  createDynamicExtensions,
  outsideTable,
  tableCellCompletions,
  tableCellPresence,
  tableCellSearch,
} from "../../../lib/editor/shared-editor";
import { createNotebookTablePresentation, notebookSourceFormulasExtension } from "../../../lib/editor/shared-tables";
import { isolateYjsHistory } from "../../../lib/yjs/history";
import { notebookWorkspaceMessages } from "../../messages";
import EditorToolbar, { formattingKeymap } from "./EditorToolbar";
import { caretFormat, insertTable, sameCaretFormat } from "./editor-actions";
import { keepReadingPosition } from "./reading-position";
import { slashCommandsExtension } from "./slash-commands";
import { createNotebookTableStructure, NOTE_EDITOR_MAX_LENGTH, type UnknownTableAction } from "./table-structure";

type ServerMode = "apply" | "reject" | "unknown" | "accepted-failure";

const params = new URLSearchParams(window.location.search);
const locale = params.get("locale") ?? "en";
const t = notebookWorkspaceMessages.resolve([locale]).t;
const initial =
  params.get("doc") ??
  [
    "# Budget",
    "",
    "@costs",
    "| Item | Hours | Cost |",
    "| --- | ---: | ---: |",
    "| Design | 2 | =Hours*50 |",
    "| Build | 3 | =Hours*50 |",
    "",
    "After the table.",
  ].join("\n");

// Local editor, the server's replica and a second person, connected like the live stream.
const doc = new Y.Doc();
const ytext = doc.getText("codemirror");
ytext.insert(0, initial);
const server = new Y.Doc();
Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
const peer = new Y.Doc();
Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
const undoManager = new Y.UndoManager(ytext);
const awareness = new Awareness(doc);
awareness.setLocalStateField("user", { userId: "u1", name: "Lena", color: "#2563eb" });
const peerAwareness = new Awareness(peer);
peerAwareness.setLocalStateField("user", { userId: "u2", name: "Paul", color: "#0a7f5a" });
peerAwareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) =>
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peerAwareness, [...added, ...updated, ...removed]), "remote"),
);

const [structureRevision, setStructureRevision] = createSignal(0);
const bump = () => setStructureRevision((value) => value + 1);
const actions = createSharedTextActionHistory(doc, undoManager, bump);
let online = true;
let mode: ServerMode = "apply";
let posts = 0;
const uploads: string[] = [];
const serverSession = crypto.randomUUID();

doc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === "remote" || actions.isRemoteOrigin(origin)) return;
  Y.applyUpdate(server, update, "remote");
  Y.applyUpdate(peer, update, "remote");
});
peer.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === "remote") return;
  Y.applyUpdate(server, update, "remote");
  actions.apply(update);
});

const respond = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
/** The server's half of POST table-action: plan against anchors, publish to the stream, then answer. */
const post = async (request: NoteTableActionRequest) => {
  posts++;
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (mode === "reject")
    return respond(409, { message: "The table changed. Check it and try again.", code: "table_target_rejected", accepted: false });
  if (mode === "unknown") return respond(500, { message: null, code: "table_action_outcome_unknown", accepted: null });
  const response = await fetch("/fixture-table-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: serverSession, state: encoding.toBase64(Y.encodeStateAsUpdate(server)), request }),
  });
  const result: unknown = await response.json();
  if (!response.ok) return respond(response.status, result);
  if (
    !result ||
    typeof result !== "object" ||
    !("update" in result) ||
    typeof result.update !== "string" ||
    !("cursor" in result) ||
    typeof result.cursor !== "string" ||
    !("retained" in result) ||
    typeof result.retained !== "boolean"
  )
    throw new Error("Invalid fixture receipt");
  const update = encoding.fromBase64(result.update);
  Y.applyUpdate(server, update, "remote");
  Y.applyUpdate(peer, update, "remote");
  actions.apply(update, request.actionId, result.cursor, result.retained);
  if (mode === "accepted-failure")
    return respond(500, { message: "Saved later.", code: "table_action_persist_failed", accepted: true, cursor: "2", receipt: null });
  return respond(200, { changed: true, cursor: result.cursor, receipt: null, focus: "focus" in result ? result.focus : null });
};

function Harness() {
  const [view, setView] = createSignal<EditorView>();
  const [controls, setControls] = createSignal<TextEditorControls>();
  const [rich, setRich] = createSignal(true);
  let scrollPort: HTMLDivElement | undefined;
  const changeRichMode = (next: boolean) => {
    const current = view();
    const restore = current && scrollPort ? keepReadingPosition(current, scrollPort) : null;
    setRich(next);
    if (restore) queueMicrotask(() => current?.dom.isConnected && restore());
  };
  const [readOnly, setReadOnly] = createSignal(false);
  const [unknown, setUnknown] = createSignal<UnknownTableAction | null>(null);
  const [format, setFormat] = createSignal(caretFormat(EditorState.create()), { equals: sameCaretFormat });
  const presentation = createNotebookTablePresentation({ notebookId: "Book01", locale: () => locale });

  const structure = createNotebookTableStructure({
    ytext,
    provider: {
      canStructure: () => online && !actions.hasPending(),
      restoreRevision: () => "1",
      beginAction: (id) => actions.begin(id),
      setInverseHandler: (handler) => actions.setInverseHandler(handler),
    },
    track: structureRevision,
    post,
    notify: (message) => controls()?.notify(message),
    fallback: () => t.tableActionFailed,
    onUnknown: (action) => setUnknown(action),
  });

  // Same order and modes as NoteEditor.client.tsx.
  let openTablePicker = () => {};
  const extensions = createDynamicExtensions();
  extensions.add(cellFormattingKeys(controls));
  extensions.add(tableCellSearch);
  extensions.add(() => yCollab(ytext, null, { undoManager }));
  extensions.add(() => isolateYjsHistory(undoManager));
  extensions.add(() => remoteCursors(ytext, awareness));
  extensions.add(tableCellPresence(ytext, awareness));
  extensions.add(editor.basicExtensions());
  extensions.add(
    slashCommandsExtension({ notebookId: "Book01", notebookName: "Budget", locale, openTablePicker: () => openTablePicker() }),
  );
  extensions.add(() => formattingKeymap({ notebookId: "Book01" }));
  extensions.add(editor.markdownExtension());
  extensions.add(editor.searchTheme());
  extensions.add(() =>
    readOnly()
      ? []
      : [
          listCommandsExtension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
          }),
        ],
  );
  extensions.add(() => {
    const dark = document.documentElement.classList.contains("dark");
    if (rich()) return dark ? editor.customDarkInit() : editor.customLightInit();
    return dark ? editor.rawDarkInit() : editor.rawLightInit();
  });
  extensions.add(editor.noteScroller);
  extensions.add(() => (rich() ? [] : [lineNumbers(), notebookSourceFormulasExtension({ locale: () => locale })]));
  extensions.add(() =>
    rich()
      ? [
          presentation.extension,
          caretIntoTableCell,
          tableCellCompletions,
          editor.imageExtension("Book01"),
          editor.listsExtension(),
          editor.infoBlocksExtension(locale),
          editor.dataBlocksExtension(),
          editor.namedBlocksExtension(),
          editor.linksExtension("Book01"),
          editor.markupExtension(),
          editor.markExtension(),
          editor.subSupExtension(),
          editor.ligaturesExtension(),
          editor.initialMarkdownDecorationRefreshExtension(),
          editor.pointerSelectionMarkdownRefreshExtension(),
          editor.katexExtension(),
          editor.codeFontExtension(),
          editor.tagPillExtension("Book01"),
        ]
      : [],
  );

  // NoteEditor uploads clipboard files from the surface; the harness records them instead.
  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    const current = view();
    if (current) {
      const after = outsideTable(current.state, current.state.selection.main.head);
      if (after !== current.state.selection.main.head) current.dispatch({ selection: { anchor: after } });
    }
    uploads.push(...files.map((file) => file.name));
  };

  onMount(() => {
    window.noteHarness = {
      ready: () => {
        const current = view();
        return !!(
          current?.dom.isConnected &&
          controls() &&
          !current.dom.closest("[hidden]") &&
          current.dom.closest(".k2b-text-editor")?.getAttribute("aria-busy") === "false"
        );
      },
      dispose: () => dispose(),
      text: () => ytext.toString(),
      editorText: () => view()?.state.doc.toString() ?? "",
      setRich: changeRichMode,
      setReadOnly,
      setOnline(value) {
        online = value;
        bump();
      },
      setServer(next) {
        mode = next;
      },
      posts: () => posts,
      uploads: () => [...uploads],
      undo: async () => {
        await actions.undo();
      },
      peerType(after, insert) {
        const text = peer.getText("codemirror");
        const at = text.toString().indexOf(after);
        if (at < 0) throw new Error(`Missing peer target: ${after}`);
        text.insert(at + after.length, insert);
      },
      peerCursor(inside, color = "#0a7f5a") {
        peerAwareness.setLocalStateField("user", { userId: "u2", name: "Paul", color });
        const text = peer.getText("codemirror");
        const at = text.toString().indexOf(inside);
        if (at < 0) throw new Error(`Missing peer cursor target: ${inside}`);
        const head = Y.createRelativePositionFromTypeIndex(text, at + 1);
        peerAwareness.setLocalStateField("cursor", { anchor: head, head });
      },
      insertTable(rows, cols) {
        const current = view();
        if (!current) throw new Error("Editor not ready");
        current.focus();
        return insertTable(current, { rows, cols }, locale);
      },
      placeCaret(text, offset) {
        if (!window.noteHarness.ready()) throw new Error("Editor runtime is not ready");
        const current = view();
        const from = current?.state.doc.toString().indexOf(text) ?? -1;
        if (!current || from < 0) throw new Error(`Missing caret target: ${text}`);
        current.focus();
        if (!current.hasFocus) throw new Error("Caret placement did not focus the visible editor");
        // Record native focus in the selection transaction. Browser tests also
        // cover Enter followed immediately by typing on Android.
        current.dispatch({ selection: { anchor: from + offset } });
      },
      async settle() {
        for (let frame = 0; frame < 4; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    };
  });

  return (
    <LocaleProvider locale={locale}>
      <div class="flex flex-1 min-h-0 min-w-0 flex-col">
        <Show when={unknown()}>
          {(action) => (
            <NoticeCard
              role="status"
              tone="warning"
              title={t.tableActionUnknownTitle}
              detail={action().message ?? t.tableActionUnknownDetail}
            >
              <Button size="sm" variant="ghost" onClick={() => action().stopWaiting()}>
                {t.tableActionStopWaiting}
              </Button>
            </NoticeCard>
          )}
        </Show>
        <ScrollArea ref={scrollPort} class="relative min-h-0 flex-1" onPaste={onPaste}>
          <TextEditor
            label={t.editorSurface}
            initialValue={ytext.toString()}
            mode={rich() ? "formatted" : "source"}
            onModeChange={(mode) => changeRichMode(mode === "formatted")}
            readOnly={readOnly()}
            presentation={() => []}
            toolbar={false}
            extensions={extensions.extension()}
            maxLength={NOTE_EDITOR_MAX_LENGTH}
            host={{
              undo: async () => {
                await actions.undo();
              },
              redo: () => {
                void actions.redo();
              },
              boundary: () => undoManager.stopCapturing(),
              structure,
              renderCell: presentation.renderCell,
            }}
            onDroppedImages={(count, files) => files.length >= count}
            onReady={(controller, next) => {
              extensions.attach(controller.view);
              setControls(next);
              setView(controller.view);
            }}
          />
        </ScrollArea>
        <EditorToolbar
          connected={true}
          editorView={view()}
          notebookId="Book01"
          noteId="Note01"
          initialPanelOpen={false}
          format={format()}
          onUndo={() => {
            void actions.undo();
          }}
          onRedo={() => {
            void actions.redo();
          }}
          onTablePickerReady={(open) => {
            openTablePicker = open;
          }}
          table={controls()}
        />
      </div>
    </LocaleProvider>
  );
}

export type NoteHarness = {
  ready: () => boolean;
  dispose: () => void;
  text: () => string;
  editorText: () => string;
  setRich: (rich: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
  setOnline: (online: boolean) => void;
  setServer: (mode: ServerMode) => void;
  posts: () => number;
  uploads: () => string[];
  undo: () => Promise<void>;
  peerType: (after: string, insert: string) => void;
  peerCursor: (inside: string, color?: string) => void;
  insertTable: (rows: number, cols: number) => Promise<void>;
  placeCaret: (text: string, offset: number) => void;
  settle: () => Promise<void>;
};

declare global {
  interface Window {
    noteHarness: NoteHarness;
  }
}

const dispose = render(() => <Harness />, document.getElementById("root")!);
