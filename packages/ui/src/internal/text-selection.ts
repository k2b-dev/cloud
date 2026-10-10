/**
 * A pointer drag sweeps across page text. No engine may turn that sweep into a
 * text selection: iPadOS starts a mouse or trackpad selection through the
 * system's text interaction, which a prevented `pointerdown` does not stop and
 * which reads only the prefixed `-webkit-user-select`. Every engine gets both
 * properties, a cancelled `selectstart`, and a selection the press or the drag
 * made anyway is cleared. Outside a drag, text selection is untouched.
 */

const properties = ["user-select", "-webkit-user-select", "-webkit-touch-callout"] as const;

type SelectionMark = { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number };

const markSelection = (): SelectionMark | null => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  return { anchorNode, anchorOffset, focusNode, focusOffset };
};

/**
 * The selection as the last press found it. A drag may start only after a
 * threshold, when the press has already begun a selection of its own; that one
 * goes, a selection from before the press stays.
 */
let selectionAtPress: SelectionMark | null = null;
if (typeof window !== "undefined") window.addEventListener("pointerdown", () => (selectionAtPress = markSelection()), true);

/** One release per active drag; the page selects text again once all are released. */
const holds = new Set<() => void>();
let restore: (() => void) | null = null;

const preventSelectStart = (event: Event) => event.preventDefault();

const releaseAll = () => {
  for (const release of [...holds]) release();
};

const engage = (): (() => void) => {
  const style = document.documentElement.style;
  const previous = properties.map((property) => [property, style.getPropertyValue(property), style.getPropertyPriority(property)] as const);
  for (const property of properties) style.setProperty(property, "none");
  const kept = selectionAtPress;
  const clearDragSelection = () => {
    const current = markSelection();
    if (!current) return;
    if (
      kept &&
      current.anchorNode === kept.anchorNode &&
      current.anchorOffset === kept.anchorOffset &&
      current.focusNode === kept.focusNode &&
      current.focusOffset === kept.focusOffset
    )
      return;
    document.getSelection()?.removeAllRanges();
  };
  clearDragSelection();
  document.addEventListener("selectstart", preventSelectStart, true);
  // WebKit reports no `selectionchange` for a selection in content that has
  // just become unselectable, so every move of the drag looks as well.
  document.addEventListener("selectionchange", clearDragSelection);
  window.addEventListener("pointermove", clearDragSelection, true);
  window.addEventListener("blur", releaseAll);
  return () => {
    clearDragSelection();
    document.removeEventListener("selectstart", preventSelectStart, true);
    document.removeEventListener("selectionchange", clearDragSelection);
    window.removeEventListener("pointermove", clearDragSelection, true);
    window.removeEventListener("blur", releaseAll);
    for (const [property, value, priority] of previous) {
      if (value) style.setProperty(property, value, priority);
      else style.removeProperty(property);
    }
  };
};

/**
 * Keeps the page from selecting text while the pointer `pointerId` drags.
 * Call it when the drag starts and the returned function when it ends; the
 * function is safe to call more than once. The pointer's `pointerup` or
 * `pointercancel` and a window `blur` end the hold as well, so a drag that
 * misses its own cleanup cannot leave the page unselectable. Overlapping drags
 * share one hold, and the last release restores the page's inline styles
 * exactly.
 */
export const suppressTextSelection = (pointerId: number): (() => void) => {
  if (typeof document === "undefined") return () => {};
  const end = (event: PointerEvent) => {
    if (event.pointerId === pointerId) release();
  };
  const release = () => {
    if (!holds.delete(release)) return;
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    if (holds.size > 0) return;
    restore?.();
    restore = null;
  };
  restore ??= engage();
  holds.add(release);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  return release;
};
