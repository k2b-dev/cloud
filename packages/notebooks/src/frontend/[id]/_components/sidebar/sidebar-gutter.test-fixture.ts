import type { Page } from "playwright";

/** The v2 Nav's gutter beside a sidebar's content (`.k2-nav`: 12 px); a v1 body in the v2 sidebar keeps the same. */
export const SIDEBAR_GUTTER = 12;

export type SidebarGutter = {
  /** Where the sidebar's content starts and ends, from the sidebar's left edge. */
  starts: { name: string; left: number; right: number }[];
  /** Every link and button that comes closer to the sidebar's edge than the gutter. */
  touching: string[];
};

/**
 * Measures the v1 sidebar body inside the v2 workspace's sidebar: the start and end of its top block (switcher, search
 * field, chips) and of its rows, and every link or button that comes closer to the sidebar's edge than the gutter. A
 * chip row that scrolls sideways is measured as its row, since a chip past its end is cut on purpose.
 */
export const measureSidebarGutter = (page: Page): Promise<SidebarGutter> =>
  page.evaluate((gutter) => {
    const side = document.querySelector<HTMLElement>("[data-k2-workspace] .k2-ws-side")!.getBoundingClientRect();
    const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const place = (name: string, element: Element | null) => {
      if (!element || !shown(element)) return [];
      const box = element.getBoundingClientRect();
      return [{ name, left: Math.round(box.left - side.left), right: Math.round(side.right - box.right) }];
    };
    const starts = [
      ...place("switcher", document.querySelector(".k2-ws-side .k2b-sidebar-switcher")),
      ...place("search", document.querySelector(".k2-ws-side .notebook-sidebar-search")),
      ...place("chips", document.querySelector(".k2-ws-side .notebook-sidebar-chips")),
      ...place("first row", document.querySelector(".k2-ws-side .k2b-app-workspace__sidebar-body a[href]")),
      ...place("foot row", document.querySelector(".k2-ws-side .k2b-app-workspace__sidebar-footer a[href]")),
    ];
    const touching = [...document.querySelectorAll<HTMLElement>(".k2-ws-side a[href], .k2-ws-side button")]
      .filter((element) => shown(element) && !element.closest(".notebook-sidebar-chips"))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left - side.left < gutter - 0.5 || side.right - box.right < gutter - 0.5);
      })
      .map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 40));
    return { starts, touching };
  }, SIDEBAR_GUTTER);
