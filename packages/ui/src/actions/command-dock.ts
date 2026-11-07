/** The gap between a docked list and its composer, and the least room it keeps to the visible edge. */
const GAP = 6;
const EDGE = 8;
/** The list's most height, as other menus have: 24rem. */
const MOST = 384;

/**
 * Docks a command list to its composer: exactly as wide as the composer and flush with its edges, just above it, or
 * below it when the visible viewport leaves more room there, as for a composer at the top. The visible viewport counts,
 * so a phone's open keyboard does not hide the list. The list scrolls within the room it gets.
 */
export const dockCommandList = (list: HTMLElement, composer: Element) => {
  const rect = composer.getBoundingClientRect();
  const view = typeof window.visualViewport === "object" ? window.visualViewport : null;
  const visibleTop = view?.offsetTop ?? 0;
  const visibleBottom = visibleTop + (view?.height ?? window.innerHeight);
  const roomAbove = rect.top - visibleTop - GAP - EDGE;
  const roomBelow = visibleBottom - rect.bottom - GAP - EDGE;
  const wanted = Math.min(list.scrollHeight, MOST);
  const above = roomAbove >= wanted || roomAbove >= roomBelow;
  list.dataset.docked = above ? "above" : "below";
  list.style.setProperty("width", `${rect.width}px`, "important");
  list.style.setProperty("left", `${rect.left}px`, "important");
  list.style.setProperty("max-height", `${Math.max(120, Math.min(MOST, above ? roomAbove : roomBelow))}px`, "important");
  list.style.setProperty("top", above ? "auto" : `${rect.bottom + GAP}px`, "important");
  list.style.setProperty("bottom", above ? `${window.innerHeight - rect.top + GAP}px` : "auto", "important");
};

/** Calls `follow` whenever the composer or the visible viewport moves or changes size; returns the cleanup. */
export const followComposer = (composer: Element, follow: () => void) => {
  const view = typeof window.visualViewport === "object" ? window.visualViewport : null;
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : undefined;
  observer?.observe(composer);
  window.addEventListener("resize", follow);
  window.addEventListener("scroll", follow, true);
  view?.addEventListener("resize", follow);
  view?.addEventListener("scroll", follow);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", follow);
    window.removeEventListener("scroll", follow, true);
    view?.removeEventListener("resize", follow);
    view?.removeEventListener("scroll", follow);
  };
};
