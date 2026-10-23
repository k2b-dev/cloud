import { standardKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, Prec, Text } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { clipboardLoading } from "./clipboard-loading";
import { commands } from "./format";
import { formattedView } from "./formatted";
import { markdown } from "./language";
import { cleanPaste } from "./paste";
import { type TableHost, tableGrid, tableHost } from "./table";

export type TextEditorMode = "formatted" | "source" | "plain";
export type TextEditorOptions = {
  parent: HTMLElement;
  /** Initial Markdown. Subsequent collaborative changes arrive through extensions. */
  doc?: string;
  mode?: TextEditorMode;
  readOnly?: boolean;
  placeholder?: string;
  label: string;
  extensions?: Extension;
  /**
   * Replaces the built-in Markdown language, highlighting, formatted markers and
   * formatting keys of the formatted and source modes. The engine keeps the
   * table grid, clean paste, limits and history routing in every mode.
   */
  presentation?: (mode: Exclude<TextEditorMode, "plain">) => Extension;
  /** The host owns history; collaboration bindings supply theirs. */
  host: TableHost;
  onChange?: (text: string) => void;
  onDroppedImages?: (count: number, files: File[]) => void;
};

const builtInPresentation = (mode: Exclude<TextEditorMode, "plain">): Extension => [
  markdown(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  mode === "formatted" ? formattedView : EditorView.contentAttributes.of({ class: "k2b-ste-source" }),
  keymap.of([
    { key: "Mod-b", run: commands.bold },
    { key: "Mod-i", run: commands.italic },
    { key: "Mod-k", run: commands.link },
    { key: "Mod-Shift-x", run: commands.strike },
  ]),
];

/** Shared engine; application extensions own transport, awareness and domain features. */
export function createTextEditor(options: TextEditorOptions) {
  const modeSlot = new Compartment();
  const readOnlySlot = new Compartment();
  const labelSlot = new Compartment();
  const presentation = options.presentation ?? builtInPresentation;
  const runHistory = (view: EditorView, direction: "undo" | "redo") => {
    view.state.facet(tableHost)?.[direction]();
    // Consume even an empty or read-only history, so another binding cannot handle it again.
    return true;
  };
  const modeExtensions = (mode: TextEditorMode): Extension =>
    mode === "plain"
      ? [clipboardLoading(() => options.host), cleanPaste(options.onDroppedImages, true)]
      : [
          presentation(mode),
          mode === "formatted" ? tableGrid() : clipboardLoading(() => options.host),
          cleanPaste(options.onDroppedImages),
        ];
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: Text.of((options.doc ?? "").split("\n")),
      extensions: [
        drawSelection(),
        EditorView.lineWrapping,
        placeholder(options.placeholder ?? ""),
        labelSlot.of(EditorView.contentAttributes.of({ "aria-label": options.label })),
        Prec.highest([
          keymap.of([
            { key: "Mod-z", run: (view) => runHistory(view, "undo"), shift: (view) => runHistory(view, "redo"), preventDefault: true },
            { key: "Mod-y", run: (view) => runHistory(view, "redo"), preventDefault: true },
          ]),
          EditorView.domEventHandlers({
            beforeinput(event, view) {
              if (event.inputType === "historyUndo") return runHistory(view, "undo");
              if (event.inputType === "historyRedo") return runHistory(view, "redo");
              return false;
            },
          }),
        ]),
        keymap.of(standardKeymap),
        tableHost.of({
          ...options.host,
          onDroppedImages: options.onDroppedImages,
          undo: () => {
            if (!view.state.readOnly) options.host.undo();
          },
          redo: () => {
            if (!view.state.readOnly) options.host.redo();
          },
        }),
        EditorState.transactionFilter.of((tr) => {
          // Only growth is refused: an over-limit text stays editable so it can be shortened.
          if (
            tr.docChanged &&
            tr.isUserEvent("input") &&
            tr.newDoc.length > options.host.maxLength &&
            tr.newDoc.length > tr.startState.doc.length
          ) {
            const inserted: string[] = [];
            tr.changes.iterChanges((_from, _to, _newFrom, _newTo, text) => {
              if (text.length) inserted.push(text.toString());
            });
            queueMicrotask(() => {
              if (inserted.length) options.host.onRecovery(inserted.join("\n"));
              options.host.onError("textTooLarge");
            });
            return [];
          }
          return tr;
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString());
        }),
        modeSlot.of(modeExtensions(options.mode ?? "formatted")),
        readOnlySlot.of([EditorState.readOnly.of(options.readOnly ?? false), EditorView.editable.of(!options.readOnly)]),
        options.extensions ?? [],
      ],
    }),
  });
  return {
    view,
    /** Also re-reads `presentation`, so a host can refresh it, e.g. after a theme change. */
    setMode: (mode: TextEditorMode) => view.dispatch({ effects: modeSlot.reconfigure(modeExtensions(mode)) }),
    setLabel: (label: string) =>
      view.dispatch({ effects: labelSlot.reconfigure(EditorView.contentAttributes.of({ "aria-label": label })) }),
    setReadOnly: (readOnly: boolean) =>
      view.dispatch({ effects: readOnlySlot.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }),
    destroy: () => view.destroy(),
  };
}
export type TextEditorController = ReturnType<typeof createTextEditor>;
