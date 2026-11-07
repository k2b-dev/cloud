import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { CloudChartBlock } from "#chat-charts";
import { disposeIslands, islandsPending, mount } from "../../../../ssr/src/mount";
import type { CloudResourceRef } from "../../contracts/capabilities";
import type { AiTurnBlock } from "../protocol";
import { PresentToolBlock } from "./file-tools";
import { AiChatActionsProvider } from "./presentation";
import { CloudCardBlock } from "./visual-tools";

/**
 * Presented files for a browser test, in a chat-wide column. `window.show(blocks)` replaces the shown `present`
 * blocks and `window.showCards(args)` the shown `card` calls. Chat files load from `/files?path=`; `window.opened`
 * records the references a reader opened.
 */
const [blocks, setBlocks] = createSignal<Extract<AiTurnBlock, { kind: "tool" }>[]>([]);
const [charts, setCharts] = createSignal<unknown[]>([]);
const [cards, setCards] = createSignal<unknown[]>([]);
const opened: { title: string; ref: CloudResourceRef }[] = [];
Object.assign(window, { show: setBlocks, showCards: setCards, showCharts: setCharts, opened });

const root = document.createElement("main");
root.style.cssText = "display: flex; flex-direction: column; gap: 1.5rem; max-width: 48rem; margin: 0 auto; padding: 1rem;";
document.body.append(root);
render(
  () => (
    <AiChatActionsProvider
      actions={{
        fileUrl: (path) => `/files?path=${encodeURIComponent(path)}`,
        onOpenReference: (title, ref) => opened.push({ title, ref }),
      }}
    >
      <For each={blocks()}>{(block) => <PresentToolBlock block={block} />}</For>
      <For each={charts()}>
        {(args) => (
          <div data-tool-chart>
            <CloudChartBlock args={args} completed />
          </div>
        )}
      </For>
      <For each={cards()}>{(args) => <CloudCardBlock args={args} />}</For>
    </AiChatActionsProvider>
  ),
  root,
);

// Server history tests use real mount/disposal rather than replacing SSR markup in the harness.
mount(CloudChartBlock, 'solid-island[data-id="chart-history"]');
Object.assign(window, {
  chartHistoryPending: () => islandsPending(document),
  disposeChartHistory: () => disposeIslands(document),
});
