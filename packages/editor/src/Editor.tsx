import type { EditorView } from "@codemirror/view";
import { TextEditor, type TextEditorProps } from "@k2b/ui/text-editor";
import { onCleanup, splitProps } from "solid-js";
import type { EditorHandle } from "./editor-state";

export type EditorProps = TextEditorProps & {
  /** Shared state from `createEditor()`; toolbars and menus placed elsewhere read and change the same editor. */
  editor: EditorHandle;
};

/**
 * The editing surface. It mounts `@k2b/ui`'s `TextEditor` with the handle's extensions, so every place added through
 * `editor.use` reaches the view. All `TextEditor` props pass through unchanged.
 */
export function Editor(props: EditorProps) {
  const [local, rest] = splitProps(props, ["editor", "extensions", "onReady"]);
  let mounted: EditorView | undefined;
  onCleanup(() => {
    if (mounted) local.editor.detach(mounted);
  });
  return (
    <TextEditor
      {...rest}
      extensions={[local.editor.extension(), local.extensions ?? []]}
      onReady={(controller, controls) => {
        mounted = controller.view;
        local.editor.attach(controller.view, { controller, controls });
        local.onReady?.(controller, controls);
      }}
    />
  );
}
