/**
 * Left and Right cycle through the segments of a row section; Up and Down leave it like any item. Returns whether
 * the key moved focus.
 */
export const focusRowSegment = (items: HTMLElement[], key: string): boolean => {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return false;
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest(".k2b-dropdown__row");
  if (!active || !row) return false;
  const segments = items.filter((item) => row.contains(item));
  const next = segments.indexOf(active) + (key === "ArrowRight" ? 1 : -1);
  segments[(next + segments.length) % segments.length]?.focus();
  return true;
};
