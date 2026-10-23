import { TextEditor } from "@k2b/ui/text-editor";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
export function mountEditor(parent: HTMLElement) {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const history = new Y.UndoManager(text);
  const awareness = new Awareness(doc);
  const dispose = render(
    () =>
      createComponent(TextEditor, {
        label: "Text",
        maxLength: 2097152,
        extensions: yCollab(text, awareness, { undoManager: history }),
        host: { undo: () => history.undo(), redo: () => history.redo(), boundary: () => history.stopCapturing() },
      }),
    parent,
  );
  return () => {
    dispose();
    history.destroy();
    awareness.destroy();
    doc.destroy();
  };
}
