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
    // the article moved on to another note meanwhile
    if (!anchor.element.isConnected) return;
    const { top, height } = anchor.element.getBoundingClientRect();
    const delta = top + anchor.within * height - anchor.offset - scroller.getBoundingClientRect().top;
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  };
};

/**
 * Keeps the text at the top of Book's scroll port in place whenever the article's width changes: the workspace hides
 * or shows its sidebar (its button or Mod+Alt+S), a grip moves, the window narrows. The position is read after each
 * scroll; a new width puts it back in the same frame, after layout and before paint. Returns the stop.
 */
export const followBookReadingPosition = (article: HTMLElement, scroller: HTMLElement): (() => void) => {
  let restore = keepBookReadingPosition(article, scroller);
  let width = article.getBoundingClientRect().width;
  let frame = 0;
  // Whoever sees a new width first puts the text back from the position read before it: a layout forced right after
  // the change lets the browser's scroll anchoring move the port, and its scroll can arrive before the observer does.
  const read = () => {
    frame = 0;
    const next = article.getBoundingClientRect().width;
    // a note that loads or a diagram that renders changes the height only
    if (Math.abs(next - width) >= 1) {
      width = next;
      restore();
    }
    restore = keepBookReadingPosition(article, scroller);
  };
  const onScroll = () => {
    frame ||= requestAnimationFrame(read);
  };
  const sizes = new ResizeObserver(() => {
    if (Math.abs(article.getBoundingClientRect().width - width) < 1) return;
    cancelAnimationFrame(frame);
    read();
  });
  sizes.observe(article);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    sizes.disconnect();
    cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", onScroll);
  };
};
