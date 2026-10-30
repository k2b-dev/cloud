import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { SelectionToolbar, Toolbar, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { EditorAction, EditorHandle } from "./editor-state";
import { editorMessages } from "./messages";
import { ToolbarButton } from "./Toolbar";

export type BubbleMenuProps = {
  editor: EditorHandle;
  /** Groups of actions, separated by a line. */
  groups: EditorAction[][];
  /** Accessible name; defaults to "Selection". */
  label?: string;
  /** Extra controls after the actions, such as "Comment". */
  children?: JSX.Element;
  /** The area the menu stays in, such as the editor's scroll area under a toolbar. */
  boundary?: () => HTMLElement | null | undefined;
  /** Show the menu also in a read-only editor, for hosts whose children work there. Defaults to `false`. */
  readOnly?: boolean;
  class?: string;
};

/** The first line of a selection in viewport coordinates; the menu centers over it. */
const selectionBox = (view: EditorView, from: number, to: number) => {
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  if (!start || !end) return null;
  const sameLine = Math.abs(start.top - end.top) < 4;
  const right = sameLine ? end.right : view.contentDOM.getBoundingClientRect().right;
  return new DOMRect(start.left, start.top, Math.max(1, right - start.left), (sameLine ? end.bottom : start.bottom) - start.top);
};

/**
 * A compact menu that floats at selected text. It opens when a selection settles, not while a pointer still drags
 * it, and closes on Escape, a collapsed selection, or when the editor loses focus. On touch it sits below the
 * selection, where the system's own selection menu does not cover it.
 */
export function BubbleMenu(props: BubbleMenuProps) {
  const locale = useLocale();
  const t = () => editorMessages.resolve([locale()]).t;
  const [dragging, setDragging] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<unknown>();
  const [geometry, setGeometry] = createSignal(0);
  // Focus that moves from the text into the menu, such as Tab to a button or a host input, keeps it open.
  const [menuFocused, setMenuFocused] = createSignal(false);
  const dismiss = () => {
    setDismissed(props.editor.state()?.selection);
    props.editor.view()?.focus();
  };

  props.editor.use([
    EditorView.domEventHandlers({
      pointerdown: () => {
        setDragging(true);
        const release = () => {
          setDragging(false);
          document.removeEventListener("pointerup", release, true);
          document.removeEventListener("pointercancel", release, true);
        };
        document.addEventListener("pointerup", release, true);
        document.addEventListener("pointercancel", release, true);
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.geometryChanged || update.viewportChanged) setGeometry((value) => value + 1);
    }),
    // Escape in the text closes an open menu first; with no menu, the key keeps its other meanings.
    Prec.high(
      keymap.of([
        {
          key: "Escape",
          run: () => {
            if (!anchor()) return false;
            dismiss();
            return true;
          },
        },
      ]),
    ),
  ]);

  const anchor = () => {
    geometry();
    const view = props.editor.view();
    const state = props.editor.state();
    if (!view || !state || dragging() || !(props.editor.focused() || menuFocused())) return null;
    if (state.readOnly && !props.readOnly) return null;
    const range = state.selection.main;
    if (range.empty || dismissed() === state.selection) return null;
    return selectionBox(view, range.from, range.to);
  };
  const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  return (
    <SelectionToolbar
      label={props.label ?? t().selection}
      anchor={anchor}
      placement={coarse() ? "below" : "above"}
      boundary={props.boundary}
      class={props.class}
      onEscape={dismiss}
    >
      <div
        style={{ display: "contents" }}
        onFocusIn={() => setMenuFocused(true)}
        onFocusOut={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setMenuFocused(false);
        }}
      >
        <For each={props.groups}>
          {(group, index) => (
            <>
              <Show when={index() > 0}>
                <Toolbar.Separator />
              </Show>
              <For each={group}>{(action) => <ToolbarButton editor={props.editor} action={action} size="sm" />}</For>
            </>
          )}
        </For>
        {props.children}
      </div>
    </SelectionToolbar>
  );
}
