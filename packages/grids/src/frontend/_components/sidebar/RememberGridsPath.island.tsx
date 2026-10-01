import { onCleanup, onMount } from "solid-js";
import { setLastGridsPath } from "./GridsSettingsStore";

/**
 * Records the shown base page as the one the Grids entry opens next. A page
 * counts only while it is visible: a tab opened in the background does not take
 * over, and returning to another tab or window, or going back to a cached page,
 * records that one.
 * It reads the current address rather than the one the page was loaded with, so
 * a record, filter, or tab changed in place is what the next visit reopens.
 */
export default function RememberGridsPath() {
  onMount(() => {
    const remember = () => {
      if (document.visibilityState !== "visible") return;
      const url = new URL(window.location.href);
      url.searchParams.delete("edit");
      url.searchParams.delete("form");
      setLastGridsPath(`${url.pathname}${url.search}`);
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
