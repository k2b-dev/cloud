import type { DictationTarget } from "@k2b/ui";
import { codeMirrorDictationTarget, dictationExtension } from "@k2b/ui/text-editor";
import type { EditorHandle } from "./editor-state";

/**
 * A dictation target for the shared editor. Words go into the document at once, as typed text does, so a shared
 * document shows them to everyone and they last as long as the host saves typed text. The mark follows local and
 * remote edits; Discard removes exactly the dictated ranges in one step, including what the person typed inside them.
 */
export function dictationTarget(editor: EditorHandle): DictationTarget {
  editor.use(dictationExtension());
  return codeMirrorDictationTarget(editor.view);
}
