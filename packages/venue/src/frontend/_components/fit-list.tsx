import { Paper } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";

/**
 * How many rows fit into `available` pixels, given each row's bottom edge measured from the top of the list.
 * When some rows do not fit, `reserve` pixels stay free for the "+N more" line.
 */
export const fittingCount = (bottoms: readonly number[], available: number, reserve: number): number => {
  const fits = (limit: number) => bottoms.filter((bottom) => bottom <= limit + 0.5).length;
  return fits(available) === bottoms.length ? bottoms.length : fits(available - reserve);
};

/**
 * The smallest height a block may shrink to: its heading and padding (`chrome`), its first row, and, when more
 * rows follow, room for the "+N more" line. A block that shows only the count would say nothing.
 */
export const blockMinimum = (chrome: number, bottoms: readonly number[], reserve: number): number =>
  bottoms.length === 0 ? 0 : Math.ceil(chrome + bottoms[0]! + (bottoms.length > 1 ? reserve : 0));

/**
 * A block of the fixed-height monitor: a heading and a list that shows the rows that fit and says how many it
 * leaves out. Every row keeps its place in the layout and only the ones past the edge turn invisible, so cutting
 * never changes the list's size and it refits whenever the block itself changes. The block never shrinks below
 * its heading and first row. Before the browser measures, the first `initial` rows show.
 */
export function FitBlock<T>(props: {
  title: string;
  /** `data-public-block` of the block. */
  block: string;
  items: readonly T[];
  initial: number;
  /** Shown instead of the list while there are no items. */
  empty?: string;
  more: (count: number) => string;
  children: (item: T) => JSX.Element;
}) {
  const [shown, setShown] = createSignal(Math.min(props.initial, props.items.length));
  const [minimum, setMinimum] = createSignal(0);
  let frame: HTMLElement | undefined;
  let box: HTMLDivElement | undefined;
  let moreLine: HTMLParagraphElement | undefined;

  const fit = () => {
    if (!frame || !box) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>(":scope > [data-fit-row]"));
    const bottoms = rows.map((row) => row.offsetTop + row.offsetHeight);
    // The line keeps a little distance from the last row it follows.
    const reserve = (moreLine?.offsetHeight ?? 0) + 4;
    setMinimum(blockMinimum(frame.offsetHeight - box.clientHeight, bottoms, reserve));
    setShown(fittingCount(bottoms, box.clientHeight, reserve));
  };

  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    if (frame) observer.observe(frame);
    if (box) observer.observe(box);
    onCleanup(() => observer.disconnect());
  });
  createEffect(
    on(
      () => props.items,
      () => queueMicrotask(fit),
      { defer: true },
    ),
  );

  const hidden = () => props.items.length - shown();
  return (
    // Until the browser measures, the block keeps room for its heading and a two-line row.
    <Paper
      as="section"
      ref={frame}
      class="flex min-h-28 flex-[0_1_auto] flex-col gap-2 p-4 lg:gap-3 lg:p-5"
      style={minimum() > 0 ? { "min-height": `${minimum()}px` } : undefined}
      data-public-block={props.block}
    >
      <h2 class="shrink-0 text-base font-semibold text-primary lg:text-lg">{props.title}</h2>
      <Show when={props.items.length > 0} fallback={<p class="text-sm text-secondary">{props.empty}</p>}>
        <div ref={box} class="relative flex min-h-0 flex-auto flex-col gap-2 overflow-hidden">
          <For each={props.items}>
            {(item, index) => (
              <div data-fit-row="" class={index() < shown() ? undefined : "invisible"} aria-hidden={index() < shown() ? undefined : "true"}>
                {props.children(item)}
              </div>
            )}
          </For>
          {/* Always rendered, so its height is known before the first row has to give way to it. */}
          <p
            ref={moreLine}
            class={`absolute inset-x-0 bottom-0 text-sm font-medium text-dimmed ${hidden() > 0 ? "" : "invisible"}`}
            data-fit-more={hidden() > 0 ? String(hidden()) : undefined}
          >
            {props.more(Math.max(hidden(), 1))}
          </p>
        </div>
      </Show>
    </Paper>
  );
}
