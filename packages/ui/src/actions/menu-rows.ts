/**
 * Left and Right cycle through the segments of a row section, or between a row and its secondary action; Up and Down
 * leave it like any item. Returns whether the key moved focus.
 */
export const focusRowSegment = (items: HTMLElement[], key: string): boolean => {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return false;
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest(".k2b-dropdown__row, .k2b-dropdown__pair");
  if (!active || !row) return false;
  const segments = items.filter((item) => row.contains(item));
  const next = segments.indexOf(active) + (key === "ArrowRight" ? 1 : -1);
  segments[(next + segments.length) % segments.length]?.focus();
  return true;
};

/**
 * Moves Up, Down, Home, or End through the rows; a row's secondary action is no stop of its own there, so Down from
 * it goes to the next row. Returns whether the key moved focus.
 */
export const focusMenuRow = (items: HTMLElement[], key: string): boolean => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const rows = items.filter((item) => !item.classList.contains("k2b-dropdown__secondary"));
  if (rows.length === 0) return true;
  if (key === "Home" || key === "End") {
    rows[key === "Home" ? 0 : rows.length - 1]?.focus();
    return true;
  }
  const active = document.activeElement as HTMLElement | null;
  const own = active?.classList.contains("k2b-dropdown__secondary")
    ? active.closest(".k2b-dropdown__pair")?.querySelector<HTMLElement>("[role^='menuitem']")
    : active;
  const current = own ? rows.indexOf(own) : -1;
  const next = current === -1 ? (key === "ArrowDown" ? 0 : rows.length - 1) : current + (key === "ArrowDown" ? 1 : -1);
  rows[(next + rows.length) % rows.length]?.focus();
  return true;
};
