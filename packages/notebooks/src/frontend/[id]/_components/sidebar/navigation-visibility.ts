import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { parseNavigatorQuery } from "../../../../lib/navigator-url";
import { readSettings, writeNavigationHidden } from "../settings/NotebookSettingsStore";
import type { NotebookContext } from "./types";

/**
 * The desktop navigation's hidden state is one global, cookie-backed
 * preference. SSR reads the cookie, so a hidden navigation never paints; in
 * the browser every surface that shows or toggles it follows this event.
 */
export const NAVIGATION_VISIBILITY_EVENT = "notebooks.navigation.visibilityChanged";
/** Dispatched before the layout changes, so the editor can note its reading position. */
export const NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT = "notebooks.navigation.visibilityWillChange";
/** Element id of the notebook sidebar, for the toggles' `aria-controls`. */
export const NOTEBOOK_NAVIGATION_ID = "notebook-navigation";

type NavigationVisibilityDetail = { hidden: boolean };

export const setNavigationHidden = (hidden: boolean) => {
  window.dispatchEvent(new CustomEvent(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT));
  writeNavigationHidden(hidden);
  window.dispatchEvent(new CustomEvent<NavigationVisibilityDetail>(NAVIGATION_VISIBILITY_EVENT, { detail: { hidden } }));
};

export const createNavigationHidden = (initial: boolean): Accessor<boolean> => {
  const [hidden, setHidden] = createSignal(initial);
  onMount(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<NavigationVisibilityDetail>>).detail;
      if (typeof detail?.hidden === "boolean") setHidden(detail.hidden);
    };
    window.addEventListener(NAVIGATION_VISIBILITY_EVENT, onChange);
    onCleanup(() => window.removeEventListener(NAVIGATION_VISIBILITY_EVENT, onChange));
  });
  return hidden;
};

/**
 * Showing a hidden navigation mounts the navigator again. It resumes from the
 * URL and the stored sort, which may have changed since the server rendered
 * the page; while hydrating, both still equal the server's values.
 */
export const navigatorStart = (ctx: NotebookContext) =>
  isServer
    ? { query: ctx.navigatorQuery, sortMode: ctx.settings.navigatorSort }
    : { query: parseNavigatorQuery(new URLSearchParams(window.location.search)), sortMode: readSettings(ctx.notebook.id).navigatorSort };
