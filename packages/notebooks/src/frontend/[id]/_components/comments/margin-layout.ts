/**
 * Where the margin's cards stand. Each card wants the height of its passage. The open card (or the composer) keeps
 * exactly that height; cards above it move up and cards below it move down until none overlap. Without an open card,
 * cards only move down. Nothing here moves the text.
 */
export const CARD_GAP = 6;

export const stackCards = (cards: readonly { want: number; height: number }[], active: number, minTop: number, gap = CARD_GAP): number[] => {
  const tops = cards.map((card) => Math.max(minTop, card.want));
  if (!cards.length) return tops;
  if (active < 0) {
    let next = minTop;
    return tops.map((top, index) => {
      const placed = Math.max(top, next);
      next = placed + cards[index]!.height + gap;
      return placed;
    });
  }
  const placed = [...tops];
  let below = placed[active]! + cards[active]!.height + gap;
  for (let index = active + 1; index < cards.length; index++) {
    placed[index] = Math.max(tops[index]!, below);
    below = placed[index]! + cards[index]!.height + gap;
  }
  let above = placed[active]!;
  for (let index = active - 1; index >= 0; index--) {
    placed[index] = Math.min(tops[index]!, above - cards[index]!.height - gap);
    above = placed[index]!;
  }
  // Cards pushed above the margin's head come back down, below it, in order.
  if (placed[0]! < minTop) {
    let next = minTop;
    for (let index = 0; index < placed.length; index++) {
      if (placed[index]! < next) placed[index] = next;
      next = placed[index]! + cards[index]!.height + gap;
    }
  }
  return placed;
};

/**
 * How the note shows its comments, from the width of its surface alone (never from how many comments there are):
 * `wide` beside the centered column, `shift` beside the column moved to the left, `compact` as dots beside the
 * lines with a popover, `phone` in sheets. The stylesheet decides with container queries; the margin reads it.
 */
export type CommentsLayout = "wide" | "shift" | "compact" | "phone";

export const commentsLayout = (surface: Element | null | undefined): CommentsLayout => {
  if (!surface) return "compact";
  const value = getComputedStyle(surface).getPropertyValue("--notebook-comments-layout").trim();
  return value === "wide" || value === "shift" || value === "phone" ? value : "compact";
};

/** Dots of passages that start on about the same line share one button. */
export const groupDots = <T extends { top: number }>(dots: readonly T[], tolerance = 8): T[][] => {
  const groups: T[][] = [];
  for (const dot of [...dots].sort((a, b) => a.top - b.top)) {
    const last = groups.at(-1);
    if (last && Math.abs(last[0]!.top - dot.top) <= tolerance) last.push(dot);
    else groups.push([dot]);
  }
  return groups;
};
