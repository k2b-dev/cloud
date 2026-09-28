import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal, createUniqueId, onCleanup } from "solid-js";
import { tabIndentExtension } from "../../../lib/editor/tab-indent";
import { TAB_KEY_PREFERENCE_EVENT } from "../detail/events";
import { readTabMovesFocus } from "../settings/NotebookSettingsStore";

/**
 * The personal Tab key preference of one note editor. Tab indents unless the note is read-only or the
 * person keeps Tab for focus movement; a change in the settings applies to the open editor without a
 * reload. While Tab indents, the editor points `aria-describedby` at `hintId`, which the caller renders.
 */
export const createTabKeyPreference = (readOnly: () => boolean) => {
  const [tabMovesFocus, setTabMovesFocus] = createSignal(readTabMovesFocus());
  const onPreference = () => setTabMovesFocus(readTabMovesFocus());
  window.addEventListener(TAB_KEY_PREFERENCE_EVENT, onPreference);
  onCleanup(() => window.removeEventListener(TAB_KEY_PREFERENCE_EVENT, onPreference));

  const hintId = createUniqueId();
  const indents = () => !readOnly() && !tabMovesFocus();
  const extension = (): Extension =>
    indents() ? [tabIndentExtension(), EditorView.contentAttributes.of({ "aria-describedby": hintId })] : [];

  return { hintId, indents, extension };
};
