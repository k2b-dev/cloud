import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** A pointer that moved further than this between press and click dragged a selection. */
const CLICK_SLOP_PX = 4;

/**
 * The element opens its link on click and, where the editor is read-only, from the keyboard as a link.
 *
 * A mouse or pen press reaches CodeMirror, so a drag that starts on the element selects text. The pointer hold keeps
 * the element rendered until release, so a click still lands on it; the click then restores the selection from before
 * the press and opens the link. A touch press keeps the native tap: it moves no caret, and the tap opens the link.
 * The widget passes `mousedown` to CodeMirror and ignores every other event.
 */
export const makeOpener = (el: HTMLElement, view: EditorView, open: () => void) => {
  el.classList.add("cm-link-open");
  el.setAttribute("role", "link");
  if (view.state.readOnly) el.tabIndex = 0;
  let touch = false;
  let press: { x: number; y: number; selection: EditorSelection } | null = null;
  el.onpointerdown = (e) => {
    touch = e.pointerType === "touch";
  };
  el.onmousedown = (e) => {
    press = null;
    if (touch) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    press = { x: e.clientX, y: e.clientY, selection: view.state.selection };
  };
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = press;
    press = null;
    if (start) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      view.dispatch({ selection: start.selection });
    }
    open();
  };
  el.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    open();
  };
};
