import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listsExtension } from "./lists";
import { markdownExtension } from "./markdown";

new EditorView({
  parent: document.getElementById("root")!,
  state: EditorState.create({ doc: "# Checklist\n\n- [x] Done\n- [ ] Open", extensions: [markdownExtension(), listsExtension()] }),
});
