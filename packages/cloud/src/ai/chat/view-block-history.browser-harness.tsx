import { Chat } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { CloudChartBlock } from "#chat-charts";

/** A real composer and an independent action surround the server history drawing. */
export function ChartHistory(props: { args: unknown; completed: boolean }) {
  const [draft, setDraft] = createSignal("");
  const [clicks, setClicks] = createSignal(0);
  const [visible, setVisible] = createSignal(true);
  onMount(() => {
    document.querySelector("solid-island")?.setAttribute("data-mounted", "true");
    Object.assign(window, { disposeChartHistory: () => setVisible(false) });
  });
  return (
    <>
      <Chat.Composer inputLabel="Message" value={draft()} onValueChange={setDraft} onSubmit={() => false} />
      <button type="button" onClick={() => setClicks(clicks() + 1)}>
        Sidebar {clicks()}
      </button>
      <Show when={visible()}>
        <CloudChartBlock {...props} />
      </Show>
    </>
  );
}
