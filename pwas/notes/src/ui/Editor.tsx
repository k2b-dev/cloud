import { TextEditor, type TextEditorController } from "@k2b/ui/text-editor";
import { onCleanup } from "solid-js";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_NOTE_LENGTH } from "../lib/model";

/**
 * The note editor. Until @k2b/editor lands this is the shared @k2b/ui text editor bound to the
 * note's Y.Text; the binding, history and remote cursors stay the same when the package replaces it.
 */
export function NoteEditor(props: {
  text: Y.Text;
  awareness: Awareness;
  label: string;
  readOnly?: boolean;
  placeholder?: string;
  autofocus?: "end" | "start";
  onReady?: (editor: TextEditorController, undo: () => void) => void;
  onFiles?: (files: File[]) => void;
}) {
  const undoManager = new Y.UndoManager(props.text);
  onCleanup(() => undoManager.destroy());
  return (
    <TextEditor
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
      }}
      extensions={[yCollab(props.text, props.awareness, { undoManager })]}
      onReady={(editor) => {
        props.onReady?.(editor, () => void undoManager.undo());
        const view = editor.view;
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
  );
}
