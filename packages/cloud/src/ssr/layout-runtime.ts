import { readPageTrail, setPageTrail } from "@k2b/ui";
import { derivePageTrail, dropSelfLinks } from "./page-trail";

export type LayoutBreadcrumb = {
  title: string;
  href?: string;
};

export type LayoutUpdate = {
  title?: string;
  breadcrumbs?: LayoutBreadcrumb[];
};

export const LAYOUT_UPDATE_EVENT = "cloud:layout:update";

/** The canvas attribute that carries the current app's base path, for the trail rule in the browser. */
export const APP_BASE_ATTRIBUTE = "data-app-base";
/** Set on the canvas of a page that shows its title without a way up: anonymous and focus-mode pages. */
const TITLE_ONLY_ATTRIBUTE = "data-page-trail-title-only";

/**
 * Window event before the way up (a trail link or Alt+↑) loads a page. Its
 * `detail.href` is where it leads: the page above, as this tab left it.
 * Cancelling it keeps the document; the listener then navigates itself.
 */
export const PAGE_UP_EVENT = "cloud:page-up";
export type PageUpDetail = { href: string };

const here = () => `${location.pathname}${location.search}`;

export const layout = {
  /**
   * Updates the page after an in-page navigation: the document title, and the
   * page title with its way up wherever the shell or `PageTrail` shows it.
   * `breadcrumbs` is the same title array `Layout` takes, under the same rule;
   * `title` alone renames the current page and keeps the levels above it.
   */
  update(update: LayoutUpdate) {
    if (typeof window === "undefined") return;

    const title = update.title ?? update.breadcrumbs?.at(-1)?.title;
    if (title) document.title = title;
    const canvas = document.querySelector(".cloud-app-canvas");
    const base = canvas?.getAttribute(APP_BASE_ATTRIBUTE) ?? undefined;
    const current = readPageTrail();
    const derived = update.breadcrumbs?.length
      ? derivePageTrail(update.breadcrumbs, base, title ?? current?.title ?? document.title)
      : title && current
        ? { ...current, title }
        : undefined;
    if (!derived) return;
    const trail = update.title ? { ...derived, title: update.title } : derived;
    setPageTrail(canvas?.hasAttribute(TITLE_ONLY_ATTRIBUTE) ? { ...trail, ancestors: [] } : trail);
    if (update.breadcrumbs?.length) {
      // An island may change the address right after this call, in the same task, so the link to the page itself
      // is known only then. Comparing earlier would drop the page the island has just left.
      queueMicrotask(() => {
        const published = readPageTrail();
        if (!published) return;
        const settled = dropSelfLinks(published, here());
        if (settled !== published) setPageTrail(settled);
      });
    }

    window.dispatchEvent(new CustomEvent<LayoutUpdate>(LAYOUT_UPDATE_EVENT, { detail: update }));
  },

  /**
   * Lets an island that navigates in place, such as a file browser, take the
   * way up itself instead of a page load that would end its running work.
   * `go` gets the destination and returns `true` when it goes there in place.
   * Returns the disposer.
   */
  handleUp(go: (href: string) => boolean): () => void {
    if (typeof window === "undefined") return () => {};
    const listener = (event: Event) => {
      if (!event.defaultPrevented && go((event as CustomEvent<PageUpDetail>).detail.href)) event.preventDefault();
    };
    window.addEventListener(PAGE_UP_EVENT, listener);
    return () => window.removeEventListener(PAGE_UP_EVENT, listener);
  },
};
