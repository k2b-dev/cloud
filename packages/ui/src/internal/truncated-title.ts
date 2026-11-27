/**
 * Text that is cut where it has no room (one line with an ellipsis, or a few lines with a clamp) says all of its words
 * as the native hint while the pointer rests on it. Whether it is cut is measured at that moment, so the hint is there
 * exactly when words are missing; assistive technology reads the full text content either way.
 */

/** Whether an element shows less than its text: cut sideways ("…" on one line) or below (a clamp of lines). */
export const isCut = (element: HTMLElement) =>
  element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;

/**
 * The hint for a pointer at (x, y) over a part made of `lines`: the whole text of the line it stands over where that
 * line is cut, else none.
 */
export const hintAt = (lines: Iterable<HTMLElement>, x: number, y: number): string | undefined => {
  for (const line of lines) {
    const box = line.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return isCut(line) ? (line.textContent ?? "") : undefined;
  }
  return undefined;
};

/** Marks a `title` this module set, so it takes back only its own hints. */
const OWN = "data-k2-hint";

/**
 * Shows `hint` as the native hint of `target`, the element the pointer is on (which may lie over the text, such as the
 * link that opens a row), or takes back a hint set before. A `title` of the element's own (a button's) stays.
 */
export const showHint = (target: EventTarget | null, hint: string | undefined) => {
  if (!(target instanceof HTMLElement)) return;
  const own = target.hasAttribute(OWN);
  if (hint !== undefined) {
    if (target.hasAttribute("title") && !own) return;
    if (target.title !== hint) target.title = hint;
    target.setAttribute(OWN, "");
  } else if (own) {
    target.removeAttribute("title");
    target.removeAttribute(OWN);
  }
};

/** For a title of one line that is the pointer's target itself (a head's name): its whole text on hover where it is cut. */
export const showTruncatedTitle = (event: PointerEvent & { currentTarget: HTMLElement }) => {
  const title = event.currentTarget;
  if (title.scrollWidth > title.clientWidth + 1) title.title = title.textContent ?? "";
  else title.removeAttribute("title");
};
