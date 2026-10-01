import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { parseNavigatorQuery } from "../../../../lib/navigator-url";
import { readNavigationHidden, readSettings, writeNavigationHidden } from "../settings/NotebookSettingsStore";
import type { NotebookContext } from "./types";

/**
 * The desktop navigation's hidden state is one global, cookie-backed
 * preference. SSR reads the cookie, so a hidden navigation never paints; in
 * the browser every surface that shows or toggles it follows this event.
 */
export const NAVIGATION_VISIBILITY_EVENT = "notebooks.navigation.visibilityChanged";
/** Dispatched before the layout changes, so the editor can note its reading position. */
export const NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT = "notebooks.navigation.visibilityWillChange";
/**
 * Dispatched, cancelable, when hiding removed the focused element. The note
 * editor claims it with `preventDefault()`; otherwise the control that shows
 * the navigation again receives focus.
 */
export const NAVIGATION_FOCUS_EVENT = "notebooks.navigation.focusLost";
/** Element id of the notebook sidebar, for the toggles' `aria-controls`. */
export const NOTEBOOK_NAVIGATION_ID = "notebook-navigation";

type NavigationVisibilityDetail = { hidden: boolean };
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export const setNavigationHidden = (hidden: boolean) => {
  const focused = document.activeElement;
  window.dispatchEvent(new CustomEvent(NAVIGATION_VISIBILITY_WILL_CHANGE_EVENT));
  writeNavigationHidden(hidden);
  window.dispatchEvent(new CustomEvent<NavigationVisibilityDetail>(NAVIGATION_VISIBILITY_EVENT, { detail: { hidden } }));
  // Hiding removes a focused tree row, list entry or resize handle, and showing
  // removes the floating show control. Without a target focus would fall back
  // to the start of the page.
  if (!focused || focused === document.body || focused.isConnected) return;
  if (!hidden) {
    document.getElementById(NOTEBOOK_NAVIGATION_ID)?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return;
  }
  if (!window.dispatchEvent(new CustomEvent(NAVIGATION_FOCUS_EVENT, { cancelable: true }))) return;
  document.querySelector<HTMLElement>(`[aria-controls="${NOTEBOOK_NAVIGATION_ID}"]`)?.focus();
};

/**
 * Another tab may have changed the preference meanwhile. When this tab comes
 * back into view it follows the stored value, so every open notebook agrees.
 */
export const followStoredNavigationHidden = (hidden: Accessor<boolean>) => {
  onMount(() => {
    const follow = () => {
      if (document.visibilityState !== "visible") return;
      const stored = readNavigationHidden();
      if (stored !== hidden()) setNavigationHidden(stored);
    };
    window.addEventListener("focus", follow);
    document.addEventListener("visibilitychange", follow);
    onCleanup(() => {
      window.removeEventListener("focus", follow);
      document.removeEventListener("visibilitychange", follow);
    });
  });
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
