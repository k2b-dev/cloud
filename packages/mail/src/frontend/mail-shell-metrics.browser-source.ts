export const tabsSelector = ".k2b-app-workspace__head-views";
export const measurements = [
  ".mail-sidebar",
  ".k2b-app-workspace__head",
  tabsSelector,
  ".k2b-app-workspace__head-filters",
  ".k2b-app-workspace__head-actions",
  ".k2b-app-workspace__head-actions button",
  "[data-workspace-primary]",
  ".k2b-app-workspace__main",
  ".k2b-view-tabs__item",
  ".k2b-filter-chip",
  ".mail-sidebar-mailbox",
  ".mail-list-entry",
  ".mail-row-draft-tag",
  "[data-mail-queue-count]",
  ".k2b-app-workspace__main-pane",
  ".k2b-app-workspace__main-primary",
  ".mail-reader-toolbar",
  "[data-mail-details-trigger]",
  "[data-app-workspace-detail-toggle]",
  ".mail-reading-column",
  ".k2b-app-workspace__detail",
].join(",");

// Rows below the fold render lazily; only the visible geometry must hold still.
export const measureGeometry = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const part = String(element.className).split(" ").filter(Boolean).join(" ");
    return rect.bottom <= 0 || rect.top >= innerHeight
      ? { part, index, x: 0, y: -1, width: 0, height: 0 }
      : { part, index, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

export const measureStrip = (selector: string) => {
  const list = document.querySelector<HTMLElement>(`${selector} .k2b-view-tabs__list`);
  if (!list) return null;
  const bounds = list.getBoundingClientRect();
  const fade = list.getAttribute("data-scroll-fade");
  const current = list.querySelector<HTMLElement>('.k2b-view-tabs__tab[aria-current="page"]');
  const rect = current && current.getClientRects().length > 0 ? current.getBoundingClientRect() : null;
  return {
    overflow: list.scrollWidth - list.clientWidth,
    current: current?.getAttribute("href") ?? null,
    left: rect ? rect.left - bounds.left : null,
    right: rect ? bounds.right - rect.right : null,
    leftInset: fade === "top" || fade === "both" ? parseFloat(getComputedStyle(list).scrollPaddingLeft) || 0 : 0,
    rightInset: fade === "bottom" || fade === "both" ? parseFloat(getComputedStyle(list).scrollPaddingRight) || 0 : 0,
    labels: Array.from(list.querySelectorAll<HTMLElement>(".k2b-view-tabs__tab .k2b-view-tabs__label"))
      .filter((label) => label.getClientRects().length > 0)
      .map((label) => ({ text: label.textContent, scroll: label.scrollWidth, width: label.clientWidth })),
  };
};
