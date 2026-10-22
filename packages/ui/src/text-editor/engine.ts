import { history, historyKeymap, redo, standardKeymap, undo } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, Prec, Text } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
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
  host: Omit<TableHost, "undo" | "redo" | "boundary"> & Partial<Pick<TableHost, "undo" | "redo" | "boundary">>;
  onChange?: (text: string) => void;
  onDroppedImages?: (count: number, files: File[]) => void;
};

/** Shared engine; application extensions own transport, awareness and domain features. */
export function createTextEditor(options: TextEditorOptions) {
  const modeSlot = new Compartment();
  const readOnlySlot = new Compartment();
  const runHistory = (view: EditorView, direction: "undo" | "redo") => {
    view.state.facet(tableHost)?.[direction]();
    // Consume even an empty or read-only history, so another binding cannot handle it again.
    return true;
  };
  const modeExtensions = (mode: TextEditorMode): Extension =>
    mode === "plain"
      ? [cleanPaste(options.onDroppedImages, true)]
      : [
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          mode === "formatted" ? [formattedView, tableGrid()] : EditorView.contentAttributes.of({ class: "ste-source" }),
          cleanPaste(options.onDroppedImages),
          keymap.of([
            { key: "Mod-b", run: commands.bold },
            { key: "Mod-i", run: commands.italic },
            { key: "Mod-k", run: commands.link },
            { key: "Mod-Shift-x", run: commands.strike },
          ]),
        ];
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: Text.of((options.doc ?? "").split("\n")),
      extensions: [
        drawSelection(),
        EditorView.lineWrapping,
        placeholder(options.placeholder ?? ""),
        EditorView.contentAttributes.of({ "aria-label": options.label }),
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
        ...(options.host.undo ? [] : [history(), keymap.of(historyKeymap)]),
        keymap.of(standardKeymap),
        tableHost.of({
          ...options.host,
          onDroppedImages: options.onDroppedImages,
          undo: () => {
            if (view.state.readOnly) return;
            if (options.host.undo) options.host.undo();
            else undo(view);
          },
          redo: () => {
            if (view.state.readOnly) return;
            if (options.host.redo) options.host.redo();
            else redo(view);
          },
          boundary: options.host.boundary ?? (() => {}),
        }),
        EditorState.transactionFilter.of((tr) => {
          if (tr.docChanged && tr.isUserEvent("input") && tr.newDoc.length > options.host.maxLength) {
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
    setMode: (mode: TextEditorMode) => view.dispatch({ effects: modeSlot.reconfigure(modeExtensions(mode)) }),
    setReadOnly: (readOnly: boolean) =>
      view.dispatch({ effects: readOnlySlot.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }),
    destroy: () => view.destroy(),
  };
}
export type TextEditorController = ReturnType<typeof createTextEditor>;
