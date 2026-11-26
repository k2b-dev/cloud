import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";

/**
 * Which tiles of a grid have come into view, by key. The grid keeps all its tiles in the page, so a photo's preview is
 * asked for only once its tile is near the view of its scrolling column (a quarter of that view ahead). The tiles are
 * found by the grid's name, in the order of `keys`, whenever the grid shows or its keys change; a tile stays seen until
 * the grid shows other keys.
 */
export function createSeenTiles(
  grid: Accessor<string>,
  keys: Accessor<readonly string[]>,
  shown: Accessor<boolean>,
): (key: string) => boolean {
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set());
  if (isServer || typeof IntersectionObserver === "undefined") return () => false;
  createEffect(
    on([keys, shown], ([current, visible]) => {
      const known = new Set(current);
      setSeen((now) => new Set([...now].filter((key) => known.has(key))));
      if (!visible) return;
      let observer: IntersectionObserver | undefined;
      // the grid may change again before the microtask runs: an effect already cleaned up starts no observer
      let done = false;
      onCleanup(() => {
        done = true;
        observer?.disconnect();
      });
      // after the grid drew the tiles of these keys
      queueMicrotask(() => {
        if (done) return;
        const tiles = [...document.querySelectorAll(`[data-k2-part="Tiles"][aria-label="${CSS.escape(grid())}"] > [role="listitem"]`)];
        if (!tiles.length) return;
        const byElement = new WeakMap<Element, string>();
        observer = new IntersectionObserver(
          (records) => {
            const seenNow = records.filter((record) => record.isIntersecting);
            // a tile seen once stays seen: it needs no more watching
            for (const record of seenNow) observer?.unobserve(record.target);
            const keys = seenNow.flatMap((record) => byElement.get(record.target) ?? []);
            if (keys.length) setSeen((now) => new Set([...now, ...keys]));
          },
          // the column that scrolls the grid, so the look-ahead is measured in its view
          { root: tiles[0]!.closest("[data-scroll-preserve]"), rootMargin: "25% 0px" },
        );
        tiles.forEach((tile, index) => {
          const key = current[index];
          if (key === undefined) return;
          byElement.set(tile, key);
          observer!.observe(tile);
        });
      });
    }),
  );
  return (key) => seen().has(key);
}
