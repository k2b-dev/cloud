import { onCleanup, onMount } from "solid-js";
import { setLastNotebookId } from "./settings/NotebookSettingsStore";

/**
 * Records the shown notebook as the one the Notebooks entry opens next.
 * Every way into a notebook ends on one of its pages, so recording here covers
 * links, search, the switcher, and typed URLs alike. A page counts only while
 * it is visible: a tab opened in the background does not take over, and
 * returning to another tab or window, or going back to a cached page, records
 * that one.
 */
export default function RememberNotebook(props: { notebookId: string }) {
  onMount(() => {
    const remember = () => {
      if (document.visibilityState === "visible") setLastNotebookId(props.notebookId);
    };
    remember();
    document.addEventListener("visibilitychange", remember);
    window.addEventListener("pageshow", remember);
    window.addEventListener("focus", remember);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", remember);
      window.removeEventListener("pageshow", remember);
      window.removeEventListener("focus", remember);
    });
  });
  return null;
}
