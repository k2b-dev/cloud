/** Scroll places of a dialog level that is hidden or moved, given back when it shows again. */
const places = new WeakMap<HTMLElement, (readonly [HTMLElement, number, number])[]>();

export const keepScroll = (level: HTMLElement) =>
  places.set(
    level,
    [...level.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollTop > 0 || element.scrollLeft > 0)
      .map((element) => [element, element.scrollTop, element.scrollLeft] as const),
  );

export const restoreScroll = (level: HTMLElement) => {
  for (const [element, top, left] of places.get(level) ?? []) element.scrollTo({ top, left, behavior: "instant" });
  places.delete(level);
};
