import type { EditorHandle } from "./editor-state";
import { type SlashMenuOptions, slashMenu } from "./slash-menu";

export type SlashMenuProps = SlashMenuOptions & { editor: EditorHandle };

/**
 * The slash menu as a place of the shared editor. It renders at the caret, so it has no markup of its own here; the
 * actions and sources it reads are tracked, and a new list reconfigures only this menu.
 */
export function SlashMenu(props: SlashMenuProps) {
  props.editor.use(() => slashMenu({ actions: props.actions, sources: props.sources }));
  return null;
}
