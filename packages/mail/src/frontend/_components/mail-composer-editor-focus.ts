import type { TextEditorController } from "@k2b/ui/text-editor";

export const focusMailComposerEditorAtStart = (editor: { view: Pick<TextEditorController["view"], "focus" | "dispatch"> }): void => {
  editor.view.dispatch({ selection: { anchor: 0 } });
  editor.view.focus();
};
