/**
 * Scrolls `scroller` alone so `item` sits fully inside it, with the "nearest" rule of `scrollIntoView`: an item already
 * in view stays put, and one larger than the view keeps its start in view. Unlike `scrollIntoView`, no ancestor moves,
 * so a strip that keeps its selection visible never scrolls the page or panel around it.
 */
export function revealInScroller(scroller: HTMLElement | undefined, item: HTMLElement | undefined) {
  if (!scroller || !item || !scroller.contains(item)) return;
  const view = scroller.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  const style = scroller.ownerDocument.defaultView?.getComputedStyle(scroller);
  const padding = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;
  const nearest = (start: number, end: number, viewStart: number, viewEnd: number) => {
    if (start >= viewStart && end <= viewEnd) return 0;
    if (start < viewStart && end > viewEnd) return 0;
    return start < viewStart ? start - viewStart : Math.min(end - viewEnd, start - viewStart);
  };
  const left = view.left + scroller.clientLeft;
  const top = view.top + scroller.clientTop;
  const dx = nearest(
    box.left,
    box.right,
    left + padding(style?.scrollPaddingLeft),
    left + scroller.clientWidth - padding(style?.scrollPaddingRight),
  );
  const dy = nearest(
    box.top,
    box.bottom,
    top + padding(style?.scrollPaddingTop),
    top + scroller.clientHeight - padding(style?.scrollPaddingBottom),
  );
  // Instant, like the first frame of a newly mounted strip: there is no motion to follow.
  if (dx || dy) scroller.scrollBy?.({ left: dx, top: dy, behavior: "instant" });
}
