import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { BlockPreviewMessages } from "./block-previews";

const messages: BlockPreviewMessages = {
  query: "Query",
  toc: "Contents",
  chart: "Chart",
  map: "Map",
  loading: "Loading",
  failed: "Failed",
  savedChanged: "Saved version changed",
  reload: "Reload",
  headingUnavailable: "Heading unavailable",
  showSource: "Show source",
  retry: "Retry",
};
const markdown = `@sales
| Month | Revenue | Profit |
| --- | --- | --- |
| Jan | 100 | =Revenue / 2 |
| Feb | 200 | =Revenue / 2 |

:::chart
type: bar
title: Profit
data: @sales
x: Month
y: Profit
:::`;

test("a local table and its formulas render a chart preview without a server", async () => {
  const dom = createDomTestHarness();
  const { chartSchema } = await import("../charts");
  const { createBlockPreviews, localChartPreviews } = await import("./block-previews");
  const charts = { maxBlocks: 10, maxSeries: 8, maxValues: 480, schema: chartSchema() };
  let reads = 0;
  let editor: EditorView | undefined;
  const dispose = render(() => {
    const host = document.createElement("div");
    const [view, setView] = createSignal<EditorView>();
    const preview = createBlockPreviews({
      source: () => "local",
      readOnly: false,
      initialMarkdown: markdown,
      view,
      enabled: () => true,
      locale: () => "en",
      charts,
      messages: () => messages,
      load: async (source) => {
        reads++;
        return localChartPreviews(source ?? markdown, "en", charts, (diagnostic) => diagnostic.code);
      },
    });
    onMount(() => {
      editor = new EditorView({
        parent: host,
        state: EditorState.create({ doc: markdown, extensions: [preview.extension, preview.listener] }),
      });
      setView(editor);
    });
    onCleanup(() => editor?.destroy());
    return host;
  }, dom.root);
  try {
    while (!dom.root.querySelector(".cm-query-block-preview svg")) await Bun.sleep(10);
    expect(reads).toBe(1);
    const preview = dom.root.querySelector(".cm-query-block-preview")!;
    expect(preview.querySelector("svg")).not.toBeNull();
    expect(preview.textContent).toContain("Profit");
    const local = localChartPreviews(markdown, "en", charts, (diagnostic) => diagnostic.code);
    expect(local.diagnostics).toEqual([]);
    expect(local.blocks[0]!.html).toContain("50");
    expect(local.blocks[0]!.html).toContain("100");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("the source switch sits with a chart's icons, and the way back is the same pressed switch", async () => {
  const dom = createDomTestHarness();
  const { chartSchema } = await import("../charts");
  const { createBlockPreviews, localChartPreviews } = await import("./block-previews");
  const charts = { maxBlocks: 10, maxSeries: 8, maxValues: 480, schema: chartSchema() };
  let editor: EditorView | undefined;
  const dispose = render(() => {
    const host = document.createElement("div");
    const [view, setView] = createSignal<EditorView>();
    const preview = createBlockPreviews({
      source: () => "local",
      readOnly: false,
      initialMarkdown: markdown,
      view,
      enabled: () => true,
      locale: () => "en",
      charts,
      messages: () => messages,
      load: async (source) => localChartPreviews(source ?? markdown, "en", charts, (diagnostic) => diagnostic.code),
    });
    onMount(() => {
      editor = new EditorView({
        parent: host,
        state: EditorState.create({ doc: markdown, extensions: [preview.extension, preview.listener] }),
      });
      setView(editor);
    });
    onCleanup(() => editor?.destroy());
    return host;
  }, dom.root);
  const show = () => dom.root.querySelector<HTMLButtonElement>('button[aria-label="Show source"]');
  try {
    while (!dom.root.querySelector('[aria-label="Copy data"]')) await Bun.sleep(10);
    const group = dom.root.querySelector(".notebook-book-chart__actions")!;
    expect([...group.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Copy data",
      "Show as table",
      "Show source",
    ]);
    expect(show()!.getAttribute("aria-pressed")).toBe("false");
    expect(show()!.querySelector("i.ti-code")).not.toBeNull();
    expect(show()!.textContent).toBe("");

    show()!.click();
    expect(dom.root.querySelector(".cm-query-block-widget")).toBeNull();
    expect(editor!.state.selection.main.head).toBe(markdown.indexOf(":::chart"));
    expect(show()!.closest(".cm-block-source-toggle")).not.toBeNull();
    expect(show()!.getAttribute("aria-pressed")).toBe("true");

    show()!.click();
    expect(dom.root.querySelector(".cm-block-source-toggle")).toBeNull();
    expect(dom.root.querySelector(".cm-query-block-widget")).not.toBeNull();
    expect(show()!.getAttribute("aria-pressed")).toBe("false");
  } finally {
    dispose();
    dom.cleanup();
  }
});
