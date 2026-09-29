import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount } from "solid-js";

/**
 * How many rows fit into `available` pixels, given each row's bottom edge measured from the top of the list.
 * When some rows do not fit, `reserve` pixels stay free for the "+N more" line.
 */
export const fittingCount = (bottoms: readonly number[], available: number, reserve: number): number => {
  const fits = (limit: number) => bottoms.filter((bottom) => bottom <= limit + 0.5).length;
  return fits(available) === bottoms.length ? bottoms.length : fits(available - reserve);
};

/**
 * A list for the fixed-height monitor: it shows the rows that fit its box and says how many it leaves out.
 * Every row keeps its place in the layout and only the ones past the edge turn invisible, so cutting never
 * changes the box's size and the list refits whenever the box itself changes. Before the browser measures,
 * the first `initial` rows show.
 */
export function FitList<T>(props: {
  items: readonly T[];
  initial: number;
  more: (count: number) => string;
  children: (item: T) => JSX.Element;
}) {
  const [shown, setShown] = createSignal(Math.min(props.initial, props.items.length));
  let box: HTMLDivElement | undefined;
  let moreLine: HTMLParagraphElement | undefined;

  const fit = () => {
    if (!box) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>(":scope > [data-fit-row]"));
    setShown(
      fittingCount(
        rows.map((row) => row.offsetTop + row.offsetHeight),
        box.clientHeight,
        // The line keeps a little distance from the last row it follows.
        (moreLine?.offsetHeight ?? 0) + 4,
      ),
    );
  };

  onMount(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(box);
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
  );
}
