import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { isServer } from "solid-js/web";
import { indexAtOffset, prefixOffsets } from "../content/virtual-sizes";

/**
 * The window of a v2 list that can grow without end (Mail's conversations, a large table): only the rows in view and
 * a margin around them are in the page; the space of the others is held by the list's padding, so the scrollbar,
 * scroll anchoring and the column's own scroller stay as they are. Heights come from the size model `VirtualFeed`
 * uses (`virtual-sizes.ts`), measured once a row was shown and kept under its key.
 *
 * - **Server and first render:** the first rows that fill a tall screen (`SERVER_ROWS`), the rest as padding; the
 *   browser's first render is the same, then the window follows the column's scroll. Nothing moves on hydration.
 * - **Focus:** the row that holds the focus stays in the page while it scrolls out of the window, parked right beside
 *   it out of view, so the focus never falls to the page.
 */

/** Rows the server renders: enough to fill a tall screen with rows of one line (40 px). */
export const SERVER_ROWS = 40;
/** The height of a row before any row was measured: one line. */
const FIRST_ESTIMATE = 40;
/** Rows are rendered this far above and below what the column shows, in px. */
const OVERSCAN = 600;

export type VirtualWindow<T> = {
  /** The items in the page, in order: the window, with the parked focus beside it. */
  shown: Accessor<readonly T[]>;
  /** The position of an item in the whole list. */
  indexOf: (item: T) => number;
  /** The space of the items before and after the ones in the page, in px. */
  before: Accessor<number>;
  after: Accessor<number>;
  /** Hands the element of the list (the scroller is found from it) once it is in the page. */
  mount: (list: HTMLElement) => void;
  /** Measures a shown item's element while it is in the page; call it while the row is made, it lets go with the row. */
  observe: (node: Element, item: T) => void;
  /**
   * Brings the item with this key into view and gives back its element; null for a key the list does not hold. It
   * renders the window at once, so call it from an event or `onMount`: inside a reactive batch or effect the rows of
   * the new window are not in the page yet and it gives back null.
   */
  reveal: (key: string) => HTMLElement | null;
};

/** What a person reaches with Tab inside a row. */
/** How far Tab looks past entries without a stop (group heads) for the next one. */
const NEIGHBOURS = 20;

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** What scrolls the list: a large table's own scroller, else the column's `.k2-scroll`, else the nearest scroller, else the page. */
const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  const column = element.closest<HTMLElement>(".k2-table-scroll[data-grid], .k2-scroll");
  if (column) return column;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
};

export const createVirtualWindow = <T>(options: {
  items: Accessor<readonly T[]>;
  key: (item: T) => string;
  /** An item that always stays in the page, such as the current entry of a sidebar. */
  pinned?: Accessor<string | undefined>;
}): VirtualWindow<T> => {
  let keys: string[] = [];
  let sizes = new Float64Array(0);
  let offsets = new Float64Array(1);
  // Heights belong to keys; a row not yet shown takes the mean of those measured, so the padding that holds its place
  // is close to its real height and nothing has to move when it comes into the page.
  const known = new Map<string, number>();
  let knownSum = 0;
  const estimate = () => (known.size > 0 ? knownSum / known.size : FIRST_ESTIMATE);
  const position = new Map<string, number>();
  /** Writes every item's height, measured or estimated, and the offsets from them. */
  const fill = () => {
    if (sizes.length !== keys.length) sizes = new Float64Array(keys.length);
    const guess = estimate();
    for (let index = 0; index < keys.length; index++) sizes[index] = known.get(keys[index]!) ?? guess;
    offsets = prefixOffsets(sizes, 0, sizes.length, offsets, 0);
  };

  const [range, setRange] = createSignal(
    { start: 0, end: Math.min(untrack(options.items).length, SERVER_ROWS) },
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );
  const [layout, setLayout] = createSignal(0);
  const [focused, setFocused] = createSignal<string>();

  // Set once the list is in the page: takes and restores the place someone reads around a change of the items.
  let hold: () => void = () => {};
  let restore: () => void = () => {};

  // The sizes follow the items: a known key keeps its height, a new one is estimated.
  const sync = createMemo(() => {
    hold();
    const items = options.items();
    keys = items.map(options.key);
    position.clear();
    keys.forEach((key, index) => position.set(key, index));
    // heights of items that left the list are forgotten
    for (const [key, size] of known)
      if (!position.has(key)) {
        known.delete(key);
        knownSum -= size;
      }
    fill();
    setLayout((value) => value + 1);
    return items;
  });

  const total = () => offsets[keys.length] ?? 0;
  const offsetOf = (index: number) => offsets[Math.max(0, Math.min(keys.length, index))] ?? 0;
  const indexOf = (item: T) => position.get(options.key(item)) ?? -1;

  /** The window, with the parked focus beside it. */
  const placed = createMemo(() => {
    const items = sync();
    layout();
    const { start: from, end: to } = range();
    const start = Math.min(from, items.length);
    const end = Math.min(Math.max(to, start), items.length);
    // the focused row and the pinned one (the current page of a sidebar) stay in the page, parked beside the window
    const parked = [...new Set([focused(), options.pinned?.()])]
      .map((key) => (key === undefined ? -1 : (position.get(key) ?? -1)))
      .filter((index) => index >= 0 && (index < start || index >= end))
      .sort((a, b) => a - b);
    const above = parked.filter((index) => index < start);
    const below = parked.filter((index) => index >= end);
    const shown = [...above.map((index) => items[index]!), ...items.slice(start, end), ...below.map((index) => items[index]!)];
    const parkedSize = (indexes: number[]) => indexes.reduce((sum, index) => sum + (sizes[index] ?? 0), 0);
    return {
      shown,
      before: Math.max(0, offsetOf(start) - parkedSize(above)),
      after: Math.max(0, total() - offsetOf(end) - parkedSize(below)),
    };
  });

  let update: () => void = () => {};
  // Rows made before the list is mounted are measured once it is.
  const pending = new Map<Element, T>();
  let measureNode: (node: Element, item: T) => void = (node, item) => {
    pending.set(node, item);
  };
  let forgetNode: (node: Element) => void = (node) => {
    pending.delete(node);
  };
  let reveal: (key: string) => HTMLElement | null = () => null;

  const mount = (list: HTMLElement) => {
    if (isServer) return;
    const scroller = scrollerOf(list);
    // The first row in view and the one after it (which takes its place when it goes), with their distance to the top.
    let held: { node: Element; top: number }[] = [];
    hold = () => {
      held = [];
      if (!scroller || scroller.scrollTop <= 0) return;
      const viewTop = scroller.getBoundingClientRect().top;
      const rows = Array.from(list.children);
      const first = rows.findIndex((row) => row.getBoundingClientRect().bottom > viewTop);
      if (first < 0) return;
      held = rows.slice(first, first + 2).map((node) => ({ node, top: node.getBoundingClientRect().top - viewTop }));
    };
    restore = () => {
      const place = held.find((each) => each.node.isConnected);
      held = [];
      if (!place || !scroller) return;
      const moved = place.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - place.top;
      if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
    };
    const view = scroller ?? document.documentElement;
    let frame = 0;
    const nodes = new WeakMap<Element, string>();
    const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    const byKey = new Map<string, Element>();
    /** How far the column is scrolled into the list, in px. */
    const scrolledIn = () => -(list.getBoundingClientRect().top - (scroller ? scroller.getBoundingClientRect().top : 0));
    // The place someone reads: the item at the top of the column and how far into it. Heights that change (a new
    // width wraps the rows anew) keep it where it is, also where the browser has no scroll anchoring (Safari).
    let anchor: { key: string; offset: number } | null = null;
    update = () => {
      frame = 0;
      const top = scrolledIn();
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const count = keys.length;
      if (count === 0) return setRange({ start: 0, end: 0 });
      const first = indexAtOffset(offsets, count, Math.max(0, top));
      anchor =
        (scroller ? scroller.scrollTop : window.scrollY) > 0 && top > 0 ? { key: keys[first]!, offset: top - offsetOf(first) } : null;
      const start = indexAtOffset(offsets, count, Math.max(0, top - OVERSCAN));
      const end = Math.min(count, indexAtOffset(offsets, count, Math.max(0, top + height + OVERSCAN)) + 1);
      setRange({ start, end });
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    /** Puts the read place back where it was after heights changed. */
    const keepAnchor = () => {
      const index = anchor ? position.get(anchor.key) : undefined;
      if (!anchor || index === undefined) return;
      const moved = offsetOf(index) + anchor.offset - scrolledIn();
      if (Math.abs(moved) < 1) return;
      if (scroller) scroller.scrollTop += moved;
      else window.scrollBy(0, moved);
    };
    // Heights of shown rows; a new height also moves the estimate of the rows not yet shown.
    const sizesSeen = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = nodes.get(entry.target);
        if (key === undefined || !position.has(key) || !entry.target.isConnected) continue;
        // an item takes its height and the gap after it (the entries of a sidebar stand 4 px apart)
        const size = (entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height) + gap;
        const before = known.get(key);
        if (size <= 0 || (before !== undefined && Math.abs(before - size) <= 0.5)) continue;
        known.set(key, size);
        knownSum += size - (before ?? 0);
        changed = true;
      }
      if (!changed) return;
      fill();
      setLayout((value) => value + 1);
      keepAnchor();
      later();
    });
    measureNode = (node, item) => {
      const key = options.key(item);
      nodes.set(node, key);
      byKey.set(key, node);
      sizesSeen.observe(node);
    };
    forgetNode = (node) => {
      sizesSeen.unobserve(node);
      const key = nodes.get(node);
      if (key !== undefined && byKey.get(key) === node) byKey.delete(key);
      nodes.delete(node);
    };
    for (const [node, item] of pending) measureNode(node, item);
    pending.clear();
    // Brings an item into view (the least scroll that shows it whole) and renders the window there at once.
    reveal = (key) => {
      const index = position.get(key);
      if (index === undefined) return null;
      const top = scrolledIn();
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const from = offsetOf(index);
      const to = offsetOf(index + 1);
      const moved = from < top ? from - top : to > top + height ? to - (top + height) : 0;
      if (moved !== 0) {
        if (scroller) scroller.scrollTop += moved;
        else window.scrollBy(0, moved);
      }
      update();
      const node = byKey.get(key);
      return node instanceof HTMLElement ? node : null;
    };
    // Tab out of a row that scrolled away (it stays in the page, parked beside the window) goes to the row after it in
    // the list, or the one before it with Shift, as if every row were in the page.
    const tabOut = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof Element)) return;
      let row: Element | null = event.target;
      while (row && row.parentElement !== list) row = row.parentElement;
      const key = row ? nodes.get(row) : undefined;
      const index = key === undefined ? undefined : position.get(key);
      const { start, end } = range();
      if (!row || index === undefined || (index >= start && index < end)) return;
      const stops = Array.from(row.querySelectorAll(TABBABLE));
      if (stops.length > 0 && stops.at(event.shiftKey ? 0 : -1) !== event.target) return;
      // the next entry that holds a stop: a group head, or a group row without a control, is passed over
      const step = event.shiftKey ? -1 : 1;
      for (let at = index + step, tried = 0; at >= 0 && at < keys.length && tried < NEIGHBOURS; at += step, tried++) {
        const target = reveal(keys[at]!);
        if (!target) continue;
        const held = target.matches(TABBABLE) ? [target] : Array.from(target.querySelectorAll<HTMLElement>(TABBABLE));
        const stop = event.shiftKey ? held.at(-1) : held[0];
        if (!stop) continue;
        event.preventDefault();
        stop.focus();
        return;
      }
    };
    list.addEventListener("keydown", tabOut);
    const resized = new ResizeObserver(later);
    resized.observe(view);
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", later, { passive: true });
    // The focused row stays in the page while it scrolls away (see `placed`).
    const focusIn = (event: FocusEvent) => {
      // the row is the child of the list that holds the focus
      let row = event.target instanceof Element ? event.target : null;
      while (row && row.parentElement !== list) row = row.parentElement;
      const key = row ? nodes.get(row) : undefined;
      if (key !== undefined) setFocused(key);
    };
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) setFocused(undefined);
    };
    list.addEventListener("focusin", focusIn);
    list.addEventListener("focusout", focusOut);
    update();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      sizesSeen.disconnect();
      resized.disconnect();
      target.removeEventListener("scroll", later);
      list.removeEventListener("focusin", focusIn);
      list.removeEventListener("focusout", focusOut);
      list.removeEventListener("keydown", tabOut);
    });
  };

  // A new list of items moves the window to what the column shows now.
  // A new list of items keeps the place someone reads: the first row in view stays where it was (as `keepPlace` does
  // for a written list; browsers with scroll anchoring already hold it, so nothing moves twice), then the window
  // follows what the column shows now. Only a change of the items is held, never a move of the window itself.
  createEffect(
    on(
      sync,
      () => {
        restore();
        update();
      },
      { defer: true },
    ),
  );

  return {
    shown: () => placed().shown,
    indexOf,
    before: () => placed().before,
    after: () => placed().after,
    mount,
    observe: (node, item) => {
      if (isServer) return;
      measureNode(node, item);
      // made with its row, so it lets go when the row leaves the page
      onCleanup(() => forgetNode(node));
    },
    reveal: (key) => reveal(key),
  };
};
