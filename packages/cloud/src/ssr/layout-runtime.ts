import { readPageTrail, setPageTrail } from "@k2b/ui";
import { derivePageTrail } from "./page-trail";

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

export const layout = {
  /**
   * Updates the page after an in-page navigation: the document title, and the
   * page title with its way up wherever the shell or `PageTrail` shows it.
   * `breadcrumbs` is the same title array `Layout` takes; `title` alone renames
   * the current page and keeps the levels above it.
   */
  update(update: LayoutUpdate) {
    if (typeof window === "undefined") return;

    const title = update.title ?? update.breadcrumbs?.at(-1)?.title;
    if (title) document.title = title;
    const base = document.querySelector(".cloud-app-canvas")?.getAttribute(APP_BASE_ATTRIBUTE) ?? undefined;
    const current = readPageTrail();
    // No self-link check here: an island may update before or after it changes the URL, so the address is no
    // reliable name for the page yet. The array an island passes describes the page it now shows.
    const trail = update.breadcrumbs?.length
      ? derivePageTrail(update.breadcrumbs, base, title ?? current?.title ?? document.title)
      : title && current
        ? { ...current, title }
        : undefined;
    if (trail) setPageTrail(update.title ? { ...trail, title: update.title } : trail);

    window.dispatchEvent(new CustomEvent<LayoutUpdate>(LAYOUT_UPDATE_EVENT, { detail: update }));
  },
};
