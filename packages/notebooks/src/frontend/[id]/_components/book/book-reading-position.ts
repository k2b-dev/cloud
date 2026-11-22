type Anchor = { element: Element; within: number; offset: number };

/** Children that stack as blocks; inline content wraps with its block and never anchors on its own. */
const blockChildren = (parent: Element) =>
  Array.from(parent.children).filter((child) => {
    const display = getComputedStyle(child).display;
    return display !== "none" && display !== "contents" && !display.startsWith("inline");
  });

/**
 * The innermost block at the port's top edge, such as a paragraph or a list
 * item, and the share of it scrolled out above the edge. A block that starts
 * below the edge, after a margin, keeps its distance instead.
 */
const readingAnchor = (article: HTMLElement, portTop: number): Anchor | null => {
  // Nothing above the port's top edge can move while the article starts below it.
  if (article.getBoundingClientRect().top >= portTop) return null;
  let element: Element = article;
  for (;;) {
    const next = blockChildren(element).find((child) => child.getBoundingClientRect().bottom > portTop);
    if (!next) break;
    element = next;
    const { top } = next.getBoundingClientRect();
    if (top >= portTop) return { element, within: 0, offset: top - portTop };
  }
  const { top, height } = element.getBoundingClientRect();
  return { element, within: (portTop - top) / Math.max(1, height), offset: 0 };
};

/**
 * Showing or hiding the navigation can narrow or widen Book view's article
 * and rewrap its text. Call this before the navigation changes and the
 * returned function right after it, before the next paint: the text at the
 * top of the scroll port stays there. The browser's own scroll anchoring
 * keeps only the block's top in place, so inside a long paragraph or list
 * item the reader's text would still move by several lines.
 *
 * The share of the block is kept rather than one exact line: rewrapped lines
 * hold different words, so a line anchor would drift with every toggle, while
 * the share returns to the same position once the navigation is back.
 */
export const keepBookReadingPosition = (article: HTMLElement, scroller: HTMLElement): (() => void) => {
  const anchor = readingAnchor(article, scroller.getBoundingClientRect().top);
  if (!anchor) return () => {};
  return () => {
    const { top, height } = anchor.element.getBoundingClientRect();
    const delta = top + anchor.within * height - anchor.offset - scroller.getBoundingClientRect().top;
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  };
};
