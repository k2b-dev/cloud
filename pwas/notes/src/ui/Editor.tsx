import { type Extension, Prec } from "@codemirror/state";
import { tooltips } from "@codemirror/view";
import { BubbleMenu, createEditor, Editor, type EditorAction, markdownActions, SlashMenu } from "@k2b/editor";
import { collab } from "@k2b/editor/collab";
import type { MarkdownUrlOptions } from "@k2b/editor/markdown";
import { createNotebookTablePresentation } from "@k2b/editor/markdown/shared-tables";
import { files as browserFiles } from "@k2b/stdlib/browser";
import type { TextEditorController, TextEditorControls } from "@k2b/ui/text-editor";
import { createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { api } from "../lib/api";
import { MAX_NOTE_LENGTH } from "../lib/model";
import { preferences } from "../prefs";
import { navigate } from "../router";
import { t } from "../state";
import { blockDiagnostic, blockPreviewMessages } from "./block-messages";
import { noteSlashActions } from "./slash-actions";
import { tagPills } from "./tag-pills";

type Presentation = { md: typeof import("@k2b/editor/markdown"); charts: typeof import("@k2b/editor/charts") };
let presentationModule: Promise<Presentation> | undefined;
/** The rendered presentation is large, so it loads in its own chunk once, after the first editor appears. */
const loadPresentation = () =>
  (presentationModule ??= Promise.all([import("@k2b/editor/markdown"), import("@k2b/editor/charts")])
    .then(([md, charts]) => ({ md, charts }))
    .catch((error: unknown) => {
      // Offline before the chunk was cached: notes stay plain Markdown, and the next editor tries again.
      presentationModule = undefined;
      throw error;
    }));

/**
 * The note editor: @k2b/editor on the note's Y.Text, with the compact bubble menu and the `/` menu of mockup v4.
 * `@k2b/editor/collab` binds the Yjs text, its undo history and the other writers' cursors; the transport stays in the app.
 */
export function NoteEditor(props: {
  text: Y.Text;
  awareness: Awareness;
  label: string;
  readOnly?: boolean;
  placeholder?: string;
  autofocus?: "end" | "start";
  onReady?: (editor: TextEditorController, undo: () => void, table?: TextEditorControls) => void;
  onFiles?: (files: File[]) => void;
  /** URLs of the note's files by key, for `file:KEY` references; a new object re-renders them. */
  files?: Record<string, string>;
  /** Read link of a shared note, for files it does not hold locally. */
  remoteReadId?: string;
}) {
  const undoManager = new Y.UndoManager(props.text);
  onCleanup(() => undoManager.destroy());
  const editor = createEditor();
  const md = () => markdownActions(editor, preferences.locale());

  const tag: EditorAction = {
    id: "tag",
    icon: "ti-hash",
    label: t().fmtTag,
    isEnabled: (state) => !state.readOnly,
    run: (view) => {
      const { from, to } = view.state.selection.main;
      const word = view.state.sliceDoc(from, to).trim().replace(/\s+/g, "-");
      view.dispatch({ changes: { from, to, insert: `#${word}` }, selection: { anchor: from + word.length + 1 } });
    },
  };
  const slash = () =>
    noteSlashActions({
      t: t(),
      md: md(),
      tag,
      inCell: () => !!editor.controls()?.tableActive(),
      pickFiles: () =>
        void browserFiles
          .showFileDialog({ accept: "image/*,application/pdf", multiple: true })
          .then((list) => props.onFiles?.(list))
          .catch(() => {}),
    });
  // Formula results are part of the table's first paint, so this stays out of the lazy presentation chunk.
  const tablePresentation = createNotebookTablePresentation({
    locale: preferences.locale,
    resolveUrl: (kind, ref) => (kind === "tag" ? `/?tag=${encodeURIComponent(ref)}` : ref),
  });
  // The Notebooks presentation: rendered lists, notices, images, links, formulas and diagrams; editing a block shows its source.
  type Loaded = { md: Presentation["md"]; previews: { extension: Extension; listener: Extension } };
  const [presentation, setPresentation] = createSignal<Loaded>();
  const owner = getOwner();
  loadPresentation().then(
    ({ md, charts }) =>
      runWithOwner(owner, () => {
        // Charts in a note are drawn from its own tables and `:::chart` blocks, in the browser; nothing goes to a server.
        const options = { maxBlocks: 20, maxSeries: 8, maxValues: 480, schema: charts.chartSchema() };
        const previews = md.createBlockPreviews({
          source: () => "note",
          readOnly: props.readOnly ?? false,
          initialMarkdown: props.text.toString(),
          view: () => editor.view(),
          enabled: () => true,
          locale: () => preferences.locale(),
          charts: options,
          messages: blockPreviewMessages,
          load: async (markdown) =>
            md.localChartPreviews(markdown ?? props.text.toString(), preferences.locale(), options, (diagnostic) =>
              blockDiagnostic(preferences.locale(), diagnostic),
            ),
        });
        setPresentation(() => ({ md, previews }));
      }),
    () => {},
  );
  // The page clips what leaves the editor's column, so popups stay inside it, also from a cell at the right on a phone.
  editor.use(() =>
    tooltips({
      tooltipSpace: (view) => {
        const { left, right } = view.dom.getBoundingClientRect();
        return { top: 0, left: Math.max(0, left), bottom: innerHeight, right: Math.min(innerWidth, right) };
      },
    }),
  );
  // In a table cell, `=` suggests functions and an open call suggests the table's columns, in the one popup.
  const formulaSources = () => {
    const loaded = presentation();
    return loaded
      ? [
          { name: "table-formulas", source: loaded.md.tableFormulaCompletionSource },
          { name: "table-columns", source: loaded.md.tableColumnCompletionSource },
        ]
      : [];
  };
  editor.use(() => {
    const loaded = presentation();
    if (!loaded) return tablePresentation.extension;
    const md = loaded.md;
    const files = props.files ?? {};
    const readId = props.remoteReadId;
    const urls: MarkdownUrlOptions = {
      resolveUrl: (_kind, ref) =>
        ref.startsWith("file:") ? (files[ref.slice(5)] ?? (readId ? api.fileUrl(readId, ref.slice(5)) : ref)) : ref,
      foreignImagesAsLinks: true,
    };
    return [
      tablePresentation.extension,
      // Above the base editor's own list bullets, so checklists show their boxes as in Notebooks.
      Prec.high(md.listsExtension()),
      props.readOnly ? [] : md.listCommandsExtension(),
      md.infoBlocksExtension(preferences.locale()),
      md.imageExtension(urls),
      md.linksExtension(urls),
      // `@name` above a table or list shows as a quiet label while the caret is elsewhere, as in Notebooks.
      md.namedBlocksExtension(),
      md.markupExtension(),
      md.markExtension(),
      md.ligaturesExtension(),
      md.initialMarkdownDecorationRefreshExtension(),
      md.pointerSelectionMarkdownRefreshExtension(),
      loaded.previews.extension,
      loaded.previews.listener,
      tagPills(md, {
        open: (tag) => navigate(`/?tag=${encodeURIComponent(tag)}`),
        label: (tag) => t().tagPillTitle({ tag }),
      }),
    ];
  });

  return (
    <>
      <Editor
        editor={editor}
        class={`n-editor${props.readOnly ? " n-readonly" : ""}`}
        label={props.label}
        initialValue={props.text.toString()}
        readOnly={props.readOnly}
        placeholder={props.placeholder}
        toolbar={false}
        maxLength={MAX_NOTE_LENGTH}
        host={{
          undo: () => undoManager.undo() !== null,
          redo: () => undoManager.redo() !== null,
          boundary: () => undoManager.stopCapturing(),
          renderCell: tablePresentation.renderCell,
        }}
        extensions={collab({ text: props.text, undoManager, awareness: props.awareness })}
        onReady={(controller, controls) => {
          props.onReady?.(controller, () => void undoManager.undo(), controls);
          const view = controller.view;
          // Cursors of others disappear when this person leaves the editor.
          const blur = () =>
            queueMicrotask(() => {
              if (!view.dom.contains(document.activeElement)) props.awareness.setLocalStateField("cursor", null);
            });
          view.dom.addEventListener("focusout", blur);
          onCleanup(() => view.dom.removeEventListener("focusout", blur));
          if (props.autofocus && !props.readOnly) {
            const position = props.autofocus === "end" ? view.state.doc.length : 0;
            view.dispatch({ selection: { anchor: position } });
            view.focus();
          }
        }}
        onDroppedImages={(_count, files) => {
          if (!props.onFiles || files.length === 0) return false;
          props.onFiles(files);
          return true;
        }}
      />
      <BubbleMenu editor={editor} groups={[[md().bold, md().italic, md().strikethrough, md().code, md().link], [tag]]} />
      <SlashMenu editor={editor} actions={slash()} sources={formulaSources()} />
    </>
  );
}
