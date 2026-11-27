/**
 * Titles in headers stay on one line and end with an ellipsis, so a long name never moves what follows. Pointing at a
 * cut title shows all of it as the native hint; assistive technology reads the full text content either way.
 */
export const showTruncatedTitle = (event: PointerEvent & { currentTarget: HTMLElement }) => {
  const title = event.currentTarget;
  if (title.scrollWidth > title.clientWidth + 1) title.title = title.textContent ?? "";
  else title.removeAttribute("title");
};

/** Whether a line shows less than its text: cut sideways with "…", or below a clamp of lines. */
export const isCut = (element: Element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;

/**
 * The whole text of the line under the pointer (`x`, `y` in the viewport) while that line is cut, else `undefined`.
 * Lines may hold one another (a cell's line and the name in it): the first cut one under the pointer counts.
 */
export const hintAt = (lines: Iterable<Element>, x: number, y: number): string | undefined => {
  for (const line of lines) {
    const box = line.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom || !isCut(line)) continue;
    return line.textContent?.trim() || undefined;
  }
  return undefined;
};

/**
 * Shows `hint` as the native hint of the element the pointer is on (an overlay link stands above the line it names),
 * marked as one set here (`data-k2-hint`): without a hint it takes away only such a hint, and it never replaces a
 * `title` the element has of its own.
 */
export const showHint = (target: EventTarget | null, hint: string | undefined) => {
  if (!(target instanceof Element)) return;
  const ours = target.hasAttribute("data-k2-hint");
  if (!ours && target.hasAttribute("title")) return;
  if (hint) {
    target.setAttribute("title", hint);
    target.setAttribute("data-k2-hint", "");
  } else if (ours) {
    target.removeAttribute("title");
    target.removeAttribute("data-k2-hint");
  }
};
