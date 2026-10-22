import { Button, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { notebookMapMessages } from "../../../../lib/map-messages";
import { BOOK_CONTENT_EVENT } from "./book-state";

/** Charts and maps remain readable in their server frame while optional interaction loads. */
export default function BookCharts(props: { rootId: string }) {
  const locale = useLocale();
  const t = () => notebookMapMessages.resolve([locale()]).t;
  const [failed, setFailed] = createSignal(false);
  let retry: () => void = () => {};
  onMount(() => {
    let cleanup: (() => void) | undefined;
    let run = 0;
    const enhance = async () => {
      const current = ++run;
      cleanup?.();
      cleanup = undefined;
      setFailed(false);
      const root = document.getElementById(props.rootId);
      if (!root?.querySelector("figure.notebook-book-chart[data-chart], figure.notebook-map[data-map-document]")) return;
      try {
        const [{ enhanceNotebookCharts }, { enhanceNotebookMaps }] = await Promise.all([
          import("../../../lib/notebook-charts"),
          import("../../../lib/notebook-maps"),
        ]);
        if (current !== run || !root.isConnected) return;
        const charts = enhanceNotebookCharts(root, locale());
        const maps = enhanceNotebookMaps(root, locale());
        cleanup = () => {
          maps();
          charts();
        };
      } catch {
        if (current === run && root.isConnected) setFailed(true);
      }
    };
    retry = () => void enhance();
    void enhance();
    window.addEventListener(BOOK_CONTENT_EVENT, enhance);
    onCleanup(() => {
      run++;
      window.removeEventListener(BOOK_CONTENT_EVENT, enhance);
      cleanup?.();
    });
  });
  return (
    <Show when={failed()}>
      <div role="status" class="notebook-map__notice">
        {t().unavailable}{" "}
        <Button size="xs" variant="text" onClick={() => retry()}>
          {t().retry}
        </Button>
      </div>
    </Show>
  );
}
