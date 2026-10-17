import { useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { BOOK_CONTENT_EVENT } from "./book-state";

/** Optional enhancement: every chart is drawn and readable without this island; it adds tooltips, table and copy. */
export default function BookCharts(props: { rootId: string }) {
  const locale = useLocale();
  onMount(() => {
    let cleanup: (() => void) | undefined;
    let run = 0;
    const enhance = async () => {
      const current = ++run;
      cleanup?.();
      cleanup = undefined;
      const root = document.getElementById(props.rootId);
      if (!root?.querySelector("figure.notebook-book-chart[data-chart]")) return;
      const { enhanceNotebookCharts } = await import("../../../lib/notebook-charts");
      if (current !== run || !root.isConnected) return;
      cleanup = enhanceNotebookCharts(root, locale());
    };
    void enhance();
    window.addEventListener(BOOK_CONTENT_EVENT, enhance);
    onCleanup(() => {
      run++;
      window.removeEventListener(BOOK_CONTENT_EVENT, enhance);
      cleanup?.();
    });
  });
  return null;
}
