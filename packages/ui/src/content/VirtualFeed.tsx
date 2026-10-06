import { type Accessor, createEffect, createRoot, createSignal, getOwner, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { useUiMessages } from "../intl/messages";

/**
 * The tallest loaded window in px. Firefox renders an element taller than about 17.9 M px with a height of 0, so the
 * feed lays out at most this much and drops far items while it keeps the reading position.
 */
const MAX_WINDOW = 8_000_000;
/** How much the loaded window grows at once when the reader nears one of its edges. */
const WINDOW_STEP = 2_000_000;
/** Rows rendered above and below the visible part, in px. */
const OVERSCAN = 600;
/** Distance from the end, in px, that still counts as being at the end. */
const END_TOLERANCE = 2;
/**
 * Rows mounted during one correction reach the ResizeObserver a frame late; measure up to this many passes at once.
 * A last pass places the rows; the observer measures what that pass mounted.
 */
const MEASURE_PASSES = 4;
const ANNOUNCE_MS = 1_000;
const HIGHLIGHT_MS = 1_600;
/** In engines without `scrollend`, the reader's scroll has ended after this long without moving. */
const QUIET_MS = 300;
/** The longest wait for the `scrollend` of the reader's scroll after it last moved, or of a write of the feed. */
const END_WAIT_MS = 1_000;

export type VirtualFeedScrollOptions = {
  /** Where the item lands in the visible area. Defaults to `"center"`. */
  align?: "start" | "center";
  /** Tints the item briefly so the reader finds it. */
  highlight?: boolean;
};

export type VirtualFeedController = {
  /**
   * Scrolls to a loaded item, also when the reader's scroll still coasts. Returns false when no loaded item has this
   * key, so the caller can load around it first.
   */
  scrollToKey: (key: string, options?: VirtualFeedScrollOptions) => boolean;
  /**
   * Follows the end again, also when the reader's scroll still coasts. When newer items exist but are not loaded, it
   * asks `onLoadNewest` for them first.
   */
  scrollToEnd: () => void;
  /** Whether the reader is at the end and new items keep the feed there. */
  isAtEnd: () => boolean;
};

export type VirtualFeedProps<T> = {
  /** Loaded items, oldest first. Replace the array to add, remove, or change items. */
  items: readonly T[];
  /** Stable, unique identity of an item across updates. */
  getKey: (item: T) => string;
  /** Height in px before the item was measured. Close estimates mean fewer corrections while scrolling. */
  estimateSize: (item: T) => number;
  /** Content of one item, created once per item object as with Solid's `For`. `index` is its position in `items`. */
  children: (item: T, index: Accessor<number>) => JSX.Element;
  /** Accessible name of the feed. */
  label: string;
  /** Accessible name of one item, for example its author and time. */
  itemLabel?: (item: T) => string | undefined;
  /**
   * Label shown above an item, for example when the day changes. Return nothing for no separator. While `hasOlder` is
   * set, the first loaded item has no known predecessor and gets none.
   */
  separator?: (item: T, previous: T | undefined) => JSX.Element;
  /** Key of the first item the reader has not seen; a marker appears above it. */
  markerKey?: string | null;
  /** Text of that marker. Defaults to "New". */
  markerLabel?: string;
  /** Older items exist that `items` does not contain yet. */
  hasOlder?: boolean;
  /** Newer items exist that `items` does not contain yet. */
  hasNewer?: boolean;
  /** Called near the start of the loaded items while `hasOlder` is true. Prepend the next older page to `items`. */
  onLoadOlder?: () => unknown;
  /** Called near the end of the loaded items while `hasNewer` is true. Append the next newer page to `items`. */
  onLoadNewer?: () => unknown;
  /** Called by "Jump to latest" while `hasNewer` is true. Replace `items` with the newest page. */
  onLoadNewest?: () => unknown;
  /** Marks the feed as busy for assistive technology, for example during the first load. */
  busy?: boolean;
  /** Number of items in the whole feed when known. */
  totalCount?: number;
  /** One-based position of `items[0]` in the whole feed when known. */
  firstPosition?: number;
  /**
   * Count shown on "Jump to latest". Defaults to the new items added while the reader was away from the end, which
   * excludes pages of older history loaded toward the end.
   */
  newCount?: number;
  /** Text announced for new items added at the end, bundled per second. Return nothing to stay silent. */
  announce?: (added: readonly T[]) => string | undefined;
  /** Called when the reader reaches or leaves the end. */
  onEndChange?: (atEnd: boolean) => void;
  /** Receives the controller once the feed is mounted. */
  controller?: (controller: VirtualFeedController) => void;
  /** Shown while `items` is empty. */
  empty?: JSX.Element;
  class?: string;
};

/**
 * One mounted row. Rows are created and removed but never moved, so focus, media, and frames inside them survive.
 * `lead` is the measured height of the separator and marker above the content.
 */
type Row<T> = { item: T; node: HTMLElement; index: number; lead?: number; setIndex: (index: number) => void; dispose: () => void };

const runsMatch = (before: readonly string[], after: readonly string[], shift: number) => {
  for (let index = 0; index < before.length; index++) if (before[index] !== after[index + shift]) return false;
  return true;
};

/** Height of the separator and marker that a row shows above its content. */
const leadOf = (node: HTMLElement) => {
  let height = 0;
  for (const child of node.children) {
    if (!child.classList.contains("k2b-virtual-feed__separator") && !child.classList.contains("k2b-virtual-feed__marker")) break;
    height += child.getBoundingClientRect().height;
  }
  return height;
};

/**
 * A virtualized feed of items with variable heights that grows at both ends and keeps the reading position: it stays
 * at the end while the reader is there, and otherwise keeps the item in view where it is, whatever loads, grows, or
 * resizes around it.
 */
export function VirtualFeed<T>(props: VirtualFeedProps<T>): JSX.Element {
  const messages = useUiMessages();
  let viewport!: HTMLDivElement;
  let feed!: HTMLDivElement;
  let log!: HTMLDivElement;

  // Layout: one size per item and prefix sums over the loaded window [lo, hi).
  let list: readonly T[] = [];
  let keys: string[] = [];
  let sizes = new Float64Array(0);
  let lo = 0;
  let hi = 0;
  let offsets = new Float64Array(1);
  let dirtyFrom = 0;

  // Reading position: follow the end, or keep one item (index) at a pixel distance (delta) below the visible top.
  let stick = true;
  let anchor = { index: 0, delta: 0 };
  /** Key of the last item while no newer items existed; items appended after it are new. */
  let endKey: string | undefined;
  /** The last scrollTop the feed wrote or accounted for; any other value comes from the reader. */
  let lastTop = 0;
  /** The viewport height the reading position was last applied to. */
  let lastHeight = 0;
  /**
   * While the reader scrolls, the feed does not write scrollTop, which would fight a finger, momentum, or a scroll
   * animation. It moves the rows by this much instead: the logical position minus the physical scrollTop.
   */
  let deferred = 0;
  /** Touches that began in the feed and have not ended. */
  const fingers = new Set<number>();
  /** Where those touches began. Their touchend still goes there after the feed removed the row. */
  const touched = new Set<EventTarget>();
  /** The reader's scroll runs, from its first move until its scrollend, or a quiet time where the engine has none. */
  let scrolling = false;
  /** A jump by the application ended the reader's scroll; what is left of its momentum is put back. */
  let overriding = false;
  let lastMove = 0;
  let endedAt = Number.NEGATIVE_INFINITY;
  /**
   * Until then, the next `scrollend` belongs to the feed's last write that moved the position. iOS delivers it late
   * enough to land in a later scroll of the reader, also in a pause of a slow momentum tail.
   */
  let owedUntil = 0;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let hasScrollEnd = false;
  /** First item appended while the reader scrolls away from the end; reaching the end is judged before it. */
  let appendedFrom = -1;
  let focusIndex = -1;
  let fresh: HTMLElement[] = [];
  let restoring = false;
  let restoreAgain = false;
  let pendingAnnouncement: T[] = [];
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  /** "Jump to latest" asked for the newest page; it waits for running loads and stops new paging until it settles. */
  let newest: "waiting" | "loading" | undefined;
  let disposed = false;
  let observeRow: (row: HTMLElement) => void = () => {};
  /** Set while the ResizeObserver callback runs. */
  let observing = false;
  let unobserveRow: (row: HTMLElement) => void = () => {};
  const owner = getOwner();
  const rows = new Map<string, Row<T>>();
  const rowOf = new WeakMap<Element, Row<T>>();

  const [version, setVersion] = createSignal(0);
  /** Changes with every new `items` array, so separators see a replaced predecessor. */
  const [listVersion, setListVersion] = createSignal(0);
  const [tabStop, setTabStop] = createSignal(-1);
  // Known on the server too, so the empty slot never flashes for a feed that has items.
  const [count, setCount] = createSignal(untrack(() => props.items.length));
  const [atEnd, setAtEnd] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  const [highlighted, setHighlighted] = createSignal<string>();
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [loadingNewer, setLoadingNewer] = createSignal(false);

  const estimate = (item: T) => {
    const size = props.estimateSize(item);
    return size > 0 ? size : 1;
  };

  const recompute = () => {
    const length = hi - lo;
    if (offsets.length !== length + 1) {
      offsets = new Float64Array(length + 1);
      dirtyFrom = 0;
    }
    for (let j = dirtyFrom; j < length; j++) offsets[j + 1] = offsets[j]! + sizes[lo + j]!;
    dirtyFrom = length;
  };
  const total = () => offsets[hi - lo]!;
  const offsetOf = (index: number) => offsets[Math.min(hi - lo, Math.max(0, index - lo))]!;
  /** The loaded item whose bottom edge lies below `y`. */
  const indexAt = (y: number) => {
    let low = 0;
    let high = hi - lo - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle + 1]! <= y) low = middle + 1;
      else high = middle;
    }
    return lo + Math.max(0, low);
  };

  const anchorAt = (top: number) => {
    const index = indexAt(top);
    return { index, delta: offsetOf(index) - top };
  };
  const logicalTop = () => viewport.scrollTop + deferred;
  const setStick = (value: boolean) => {
    // The anchor is not maintained while following the end; leaving the end keeps what is visible now.
    if (stick && !value && hi > lo) anchor = anchorAt(logicalTop());
    stick = value;
    if (value) setUnseen(0);
    if (atEnd() === value) return;
    setAtEnd(value);
    props.onEndChange?.(value);
  };
  /**
   * Whether `top` shows the end. It is judged in the geometry the position was last applied to: a viewport resize
   * not yet handled, and items appended while the reader scrolls away from the end, do not count yet.
   */
  const reachesEnd = (top: number) =>
    hi === list.length && !props.hasNewer && (appendedFrom >= 0 ? offsetOf(appendedFrom) : total()) - (top + lastHeight) <= END_TOLERANCE;

  const deferring = () => fingers.size > 0 || scrolling;
  /**
   * Whether the rows may stand in for the logical position `top` while the reader scrolls. Near the start they may
   * not: rows moved down would show empty space above the first item, and rows moved up would put the first items
   * out of the scroll range's reach. The margin is the overscan, so the write lands before the engine draws there.
   */
  const mayDefer = (top: number) => deferring() && Math.min(viewport.scrollTop, top) > OVERSCAN;
  /** Scrolls to `target`, within what the layout can reach, and returns the position the reader gets. */
  const writeTop = (target: number, immediate: boolean) => {
    const next = Math.min(Math.max(0, total() - viewport.clientHeight), Math.max(0, target));
    if (!immediate && mayDefer(next)) {
      // The rows move instead; the scroll range stays the same, so the engine clamps nothing.
      lastTop = viewport.scrollTop;
      deferred = next - lastTop;
      feed.style.height = `${total() - deferred}px`;
      return next;
    }
    deferred = 0;
    feed.style.height = `${total()}px`;
    const from = viewport.scrollTop;
    if (Math.abs(from - next) > 0.5) viewport.scrollTop = next;
    lastTop = viewport.scrollTop;
    if (Math.abs(lastTop - from) > 0.5) owedUntil = performance.now() + END_WAIT_MS;
    return next;
  };

  const updateRange = () => {
    const top = logicalTop();
    const height = viewport.clientHeight;
    const indices: number[] = [];
    if (hi > lo) {
      const start = indexAt(top - OVERSCAN);
      const end = indexAt(top + height + OVERSCAN);
      // The focused row stays mounted wherever it is, so focus never falls back to the document.
      const focused = focusIndex >= lo && focusIndex < hi;
      if (focused && focusIndex < start) indices.push(focusIndex);
      for (let index = start; index <= end; index++) indices.push(index);
      if (focused && focusIndex > end) indices.push(focusIndex);
    }
    renderRows(indices);
    setTabStop(focusIndex >= lo && focusIndex < hi ? focusIndex : hi > lo ? indexAt(top + height - 1) : -1);
  };

  const measure = (measured: ReadonlyArray<readonly [HTMLElement, number]>) => {
    let changed = false;
    for (const [node, size] of measured) {
      const row = rowOf.get(node);
      if (!row || row.index < lo || row.index >= hi) continue;
      const index = row.index;
      // The anchor keeps the content of its row in place: a separator or marker that appears or goes away above it
      // moves the row's top instead.
      const lead = leadOf(node);
      if (!stick && index === anchor.index && row.lead !== undefined) anchor = { index, delta: anchor.delta + row.lead - lead };
      row.lead = lead;
      if (Math.abs(sizes[index]! - size) > 0.1) {
        sizes[index] = size;
        dirtyFrom = Math.min(dirtyFrom, index - lo);
        changed = true;
      }
    }
    return changed;
  };

  const position = (index: number) =>
    props.firstPosition !== undefined ? props.firstPosition + index : props.hasOlder ? undefined : index + 1;
  const setSize = () => props.totalCount ?? (props.hasOlder || props.hasNewer ? -1 : count());

  const createRow = (item: T, key: string, at: number): Row<T> =>
    createRoot((dispose) => {
      const [index, setIndex] = createSignal(at);
      // While older items may come, the first loaded item's predecessor is unknown, so it gets no separator yet.
      const separator = () => (listVersion(), index() === 0 && props.hasOlder ? undefined : props.separator?.(item, list[index() - 1]));
      // Created once, as Solid's For does, so signals that the content reads while rendering never rebuild it.
      const content = untrack(() => props.children(item, index));
      const node = (
        <div
          class="k2b-virtual-feed__item"
          role="article"
          data-index={index()}
          data-key={key}
          data-highlighted={highlighted() === key ? "" : undefined}
          tabindex={index() === tabStop() ? 0 : -1}
          aria-label={props.itemLabel?.(item)}
          aria-posinset={position(index())}
          aria-setsize={setSize()}
          style={{ transform: `translateY(${(version(), offsetOf(index()) - deferred)}px)` }}
        >
          <Show when={separator()}>
            {(content) => (
              <div class="k2b-virtual-feed__separator">
                <span>{content()}</span>
              </div>
            )}
          </Show>
          <Show when={props.markerKey === key}>
            <div class="k2b-virtual-feed__marker">
              <span>{props.markerLabel ?? messages().feedNewMarker}</span>
            </div>
          </Show>
          {content}
        </div>
      ) as HTMLElement;
      const row: Row<T> = {
        item,
        node,
        index: at,
        setIndex: (next) => {
          row.index = next;
          setIndex(next);
        },
        dispose,
      };
      return row;
    }, owner);

  /** Mounts exactly these items in this order; rows that stay keep their node in place. */
  const renderRows = (indices: readonly number[]) => {
    const wanted = new Map<string, number>();
    for (const index of indices) wanted.set(keys[index]!, index);
    const active = feed.contains(document.activeElement) ? (document.activeElement as HTMLElement) : undefined;
    let focusedKey: string | undefined;
    for (const [key, row] of rows) {
      const index = wanted.get(key);
      if (index !== undefined && list[index] === row.item) continue;
      if (active && row.node.contains(active)) focusedKey = key;
      unobserveRow(row.node);
      row.node.remove();
      row.dispose();
      rows.delete(key);
    }
    let cursor = feed.firstChild;
    for (const index of indices) {
      const key = keys[index]!;
      let row = rows.get(key);
      if (row) row.setIndex(index);
      else {
        row = createRow(list[index]!, key, index);
        rows.set(key, row);
        rowOf.set(row.node, row);
        observeRow(row.node);
        fresh.push(row.node);
      }
      if (row.node === cursor) cursor = cursor.nextSibling;
      else feed.insertBefore(row.node, cursor);
    }
    // A reordered item moves its node, which blurs it, and a replaced item gets a new row: focus stays on the item.
    // Only when the item is gone does it fall back to the scroll area.
    if (active && document.activeElement !== active) {
      const replaced = focusedKey === undefined ? undefined : rows.get(focusedKey)?.node;
      (active.isConnected ? active : (replaced ?? viewport)).focus({ preventScroll: true });
    }
  };

  /**
   * Puts the reading position back after sizes, items, or the viewport changed: the end while following it, the
   * anchor otherwise. While the reader scrolls, it moves the rows instead of the scroll position, except for
   * `immediate` corrections, which follow structural changes and jumps.
   */
  const restore = (immediate = false) => {
    if (!viewport) return;
    if (restoring) {
      restoreAgain = true;
      return;
    }
    restoring = true;
    let target = 0;
    let top = 0;
    // Following the end shows the end of all items from now on, so later moves are judged against it.
    if (stick) appendedFrom = -1;
    try {
      for (let pass = 0; ; pass++) {
        restoreAgain = false;
        recompute();
        target = stick ? total() : offsetOf(anchor.index) - anchor.delta;
        top = writeTop(target, immediate);
        updateRange();
        setVersion((value) => value + 1);
        if (pass === MEASURE_PASSES) break;
        // Rows mounted here reach the ResizeObserver only next frame (its loop limit), so measure them now.
        const mounted = fresh.filter((node) => node.isConnected);
        fresh = [];
        if (measure(mounted.map((node) => [node, node.getBoundingClientRect().height] as const))) restoreAgain = true;
        if (!restoreAgain) break;
      }
      // A position the layout cannot reach, above its start or past its end, becomes the one the reader sees, so a
      // page that loads there later keeps it instead of moving to it.
      if (!stick && Math.abs(top - target) > 0.5) anchor = { index: anchor.index, delta: offsetOf(anchor.index) - top };
    } finally {
      restoring = false;
    }
    checkEdges();
  };

  /**
   * Keeps the reader's new position, reached from `from`. A row that the move reveals at the top can change size in the
   * same frame, before the feed measured it, and the reader never saw it. So the row at the top of `from` keeps its
   * place while it is still in view, and the rows the reader saw move by the reader's step alone.
   */
  const captureAnchor = (from: number) => {
    const top = logicalTop();
    setStick(reachesEnd(top));
    const seen = indexAt(from);
    anchor =
      offsetOf(seen + 1) > top && offsetOf(seen) < top + viewport.clientHeight
        ? { index: seen, delta: offsetOf(seen) - top }
        : anchorAt(top);
  };

  /**
   * Whether scrollTop moved since the feed last wrote or accounted for it. When a size change shortens the scroll
   * range, the engine clamps the position onto the new end; that move is the size change, not the reader.
   */
  const readerMoved = () => {
    const top = viewport.scrollTop;
    if (Math.abs(top - lastTop) <= 0.5) return false;
    const end = viewport.scrollHeight - viewport.clientHeight;
    return !(lastTop > end + 1 && Math.abs(top - end) <= 1);
  };

  /**
   * Takes a scroll position the feed did not make as the reader's, whatever moved it: touch, momentum, wheel, keys,
   * the scrollbar, focus, scrollIntoView, find in page, or assistive technology. Returns whether there was one.
   */
  const noteReader = () => {
    if (!readerMoved()) return false;
    lastMove = performance.now();
    if (overriding) {
      // Momentum left from before a jump of the application does not take the reader away again.
      armEnd(QUIET_MS);
      restore(true);
      return false;
    }
    armEnd();
    const from = lastTop + deferred;
    lastTop = viewport.scrollTop;
    scrolling = true;
    captureAnchor(from);
    return true;
  };

  const armEnd = (ms = hasScrollEnd ? END_WAIT_MS : QUIET_MS) => {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      endTimer = undefined;
      // A finger holds the scroll until it lifts; a move without its scroll event yet continues it.
      if (fingers.size > 0) return;
      if (readerMoved()) noteReader();
      else endScroll();
    }, ms);
  };

  /** The reader's scroll ended: what it held back is written in one step that moves nothing the reader sees. */
  const endScroll = () => {
    clearTimeout(endTimer);
    endTimer = undefined;
    scrolling = false;
    overriding = false;
    appendedFrom = -1;
    restore();
  };

  /**
   * A jump of the application ends the reader's scroll in progress: the jump lands at once, and what is left of the
   * momentum is put back until it has been still for a quiet time, or the reader touches, wheels, clicks, or presses
   * a key. A scrollend does not end this: a momentum stopped by the engine can still deliver a step in flight.
   */
  const takeOver = () => {
    appendedFrom = -1;
    if (!scrolling || fingers.size > 0) return;
    scrolling = false;
    overriding = true;
    lastMove = performance.now();
    armEnd(QUIET_MS);
    // A scroller that cannot scroll drops its momentum where the engine allows that. It scrolls again after a frame
    // in which nothing was left to put back.
    viewport.style.overflowY = "hidden";
    let seen = Number.NaN;
    const check = () => {
      if (disposed) return;
      if (overriding && lastMove !== seen) {
        seen = lastMove;
        requestAnimationFrame(check);
      } else viewport.style.removeProperty("overflow-y");
    };
    requestAnimationFrame(check);
  };

  /** Lays out a window of about half the maximum around `center`. */
  const windowAround = (center: number) => {
    lo = center;
    hi = center + 1;
    let height = sizes[center]!;
    while (height < MAX_WINDOW / 2 && (lo > 0 || hi < list.length)) {
      if (lo > 0 && (center - lo <= hi - 1 - center || hi >= list.length)) height += sizes[--lo]!;
      else height += sizes[hi++]!;
    }
    dirtyFrom = 0;
  };

  const dropFocus = () => {
    if (focusIndex >= lo && focusIndex < hi) return;
    const focused = rows.get(keys[focusIndex] ?? "")?.node;
    focusIndex = -1;
    if (focused?.contains(document.activeElement)) viewport.focus({ preventScroll: true });
  };

  /**
   * Drops items from one side of the window, never those around the reading position, until it fits again. Returns
   * whether it dropped any.
   */
  const trimWindow = (side: "start" | "end") => {
    recompute();
    let excess = total() - MAX_WINDOW;
    if (excess <= 0) return false;
    const [from, to] = [lo, hi];
    const height = viewport.clientHeight;
    const top = stick ? total() - height : offsetOf(anchor.index) - anchor.delta;
    // While following the end the anchor is not maintained; only the visible end counts.
    const first = Math.min(indexAt(top - height - OVERSCAN), stick ? hi : anchor.index);
    const last = Math.max(indexAt(top + 2 * height + OVERSCAN), stick ? lo : anchor.index);
    if (side === "start") while (excess > 0 && lo < first) excess -= sizes[lo++]!;
    else while (excess > 0 && hi - 1 > last) excess -= sizes[--hi]!;
    dirtyFrom = 0;
    dropFocus();
    return lo !== from || hi !== to;
  };

  const loadNewest = () => {
    if (loadingOlder() || loadingNewer()) {
      newest = "waiting";
      return;
    }
    newest = "loading";
    load("newest");
  };

  const load = (direction: "older" | "newer" | "newest") => {
    const setLoading = direction === "older" ? setLoadingOlder : setLoadingNewer;
    const callback = direction === "older" ? props.onLoadOlder : direction === "newer" ? props.onLoadNewer : props.onLoadNewest;
    if (!callback) return;
    // A load succeeded when its edge moved; other changes to `items` meanwhile do not count.
    const edge = () => (direction === "older" ? keys[0] : keys[keys.length - 1]);
    const before = edge();
    setLoading(true);
    let result: unknown;
    try {
      result = callback();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .then(() => {
        setLoading(false);
        if (disposed) return;
        if (direction === "newest") newest = undefined;
        if (newest === "waiting") {
          if (!loadingOlder() && !loadingNewer()) loadNewest();
          return;
        }
        const arrived = edge() !== before;
        // A failed or empty load toward the end shows "Jump to latest" again instead of following an end that never came.
        if (direction !== "older" && !arrived && stick && props.hasNewer) setStick(false);
        // Keep loading while the reader still sits at the edge and the last page arrived.
        if (arrived) checkEdges();
      });
  };

  /** Grows the window or asks for more items when the reader nears an edge. */
  const checkEdges = () => {
    if (hi <= lo || restoring) return;
    const top = logicalTop();
    const height = viewport.clientHeight;
    // Rows measured taller than estimated can grow the window past the cap without any edge moving.
    if (total() > MAX_WINDOW && trimWindow(top + height / 2 > total() / 2 ? "start" : "end")) {
      restore(true);
      return;
    }
    const margin = Math.max(2_000, 3 * height);
    if (top < margin) {
      if (lo > 0) {
        let added = 0;
        while (lo > 0 && added < WINDOW_STEP) added += sizes[--lo]!;
        dirtyFrom = 0;
        trimWindow("end");
        restore(true);
        return;
      }
      if (props.hasOlder && !loadingOlder() && !newest) load("older");
    }
    if (total() - top - height < margin) {
      if (hi < list.length) {
        let added = 0;
        while (hi < list.length && added < WINDOW_STEP) added += sizes[hi++]!;
        dirtyFrom = 0;
        trimWindow("start");
        restore(true);
        return;
      }
      if (props.hasNewer && !loadingNewer() && !newest) load("newer");
    }
  };

  const queueAnnouncement = (added: readonly T[]) => {
    pendingAnnouncement = pendingAnnouncement.concat(added);
    if (announceTimer !== undefined) return;
    announceTimer = setTimeout(() => {
      announceTimer = undefined;
      const batch = pendingAnnouncement;
      pendingAnnouncement = [];
      const text = props.announce ? props.announce(batch) : messages().feedNewItems({ count: batch.length });
      if (!text) return;
      const line = document.createElement("p");
      line.textContent = text;
      log.append(line);
      while (log.childElementCount > 3) log.firstElementChild?.remove();
    }, ANNOUNCE_MS);
  };

  /** Applies a new `items` array: appends follow the end, prepends and other changes keep the anchor by key. */
  const sync = (next: readonly T[]) => {
    // The reader may have scrolled in this frame before its scroll event ran; take that position first.
    if (keys.length > 0) noteReader();
    const length = next.length;
    const nextKeys = next.map(props.getKey);
    const previous = keys.length;
    const focusKey = focusIndex >= 0 ? keys[focusIndex] : undefined;
    let added: readonly T[] = [];
    let appended = false;
    /** A new feed, or one that shares no item with the last: start at its end. */
    const reset = () => {
      sizes = Float64Array.from(next, estimate);
      focusIndex = -1;
      appendedFrom = -1;
      setStick(!props.hasNewer);
      anchor = { index: 0, delta: 0 };
      setUnseen(0);
      // Pending announcements describe the items that are gone.
      clearTimeout(announceTimer);
      announceTimer = undefined;
      pendingAnnouncement = [];
      list = next;
      if (sizes.reduce((sum, size) => sum + size, 0) <= MAX_WINDOW) {
        lo = 0;
        hi = length;
      } else windowAround(length - 1);
    };
    if (previous === 0 || length === 0) reset();
    else if (length >= previous && runsMatch(keys, nextKeys, 0)) {
      const grown = new Float64Array(length);
      grown.set(sizes);
      for (let index = previous; index < length; index++) grown[index] = estimate(next[index]!);
      sizes = grown;
      if (hi === previous) hi = length;
      appended = true;
      // Away from the end, the reader's scroll in progress still reaches the end it was heading for.
      if (!stick && deferring() && appendedFrom < 0) appendedFrom = previous;
      // Only items after the newest one the feed has known are new; older pages toward the end are history.
      const known = endKey === undefined ? -1 : nextKeys.lastIndexOf(endKey);
      if (known >= 0) added = next.slice(Math.max(previous, known + 1));
    } else if (length >= previous && runsMatch(keys, nextKeys, length - previous)) {
      const shift = length - previous;
      const grown = new Float64Array(length);
      grown.set(sizes, shift);
      for (let index = 0; index < shift; index++) grown[index] = estimate(next[index]!);
      sizes = grown;
      anchor = { index: anchor.index + shift, delta: anchor.delta };
      if (focusIndex >= 0) focusIndex += shift;
      if (appendedFrom >= 0) appendedFrom += shift;
      if (lo > 0) lo += shift;
      hi += shift;
    } else {
      const known = new Map<string, number>();
      for (let index = 0; index < previous; index++) known.set(keys[index]!, sizes[index]!);
      const position = new Map<string, number>();
      for (let index = 0; index < length; index++) position.set(nextKeys[index]!, index);
      if (!nextKeys.some((key) => known.has(key))) reset();
      else {
        sizes = new Float64Array(length);
        for (let index = 0; index < length; index++) sizes[index] = known.get(nextKeys[index]!) ?? estimate(next[index]!);
        // An item that is gone hands its role to the nearest surviving neighbor.
        const survivor = (from: number) => {
          for (let distance = 0; distance < previous; distance++) {
            const below = position.get(keys[from + distance] ?? "");
            if (below !== undefined) return below;
            const above = position.get(keys[from - distance] ?? "");
            if (above !== undefined) return above;
          }
          return length - 1;
        };
        const wasAtStart = lo === 0;
        const wasAtEnd = hi === previous;
        appendedFrom = -1;
        anchor = { index: survivor(anchor.index), delta: anchor.delta };
        focusIndex = focusKey === undefined ? -1 : (position.get(focusKey) ?? -1);
        lo = wasAtStart ? 0 : survivor(lo);
        hi = wasAtEnd ? length : survivor(hi - 1) + 1;
        if (anchor.index < lo || anchor.index >= hi) {
          list = next;
          windowAround(anchor.index);
        }
      }
    }
    list = next;
    keys = nextKeys;
    dirtyFrom = 0;
    setCount(length);
    setListVersion((value) => value + 1);
    if (!props.hasNewer) endKey = nextKeys[length - 1];
    recompute();
    const center = stick ? hi - 1 : anchor.index;
    const trimmed = total() > MAX_WINDOW && trimWindow(center - lo > hi - 1 - center ? "start" : "end");
    // Appended items wait for the reader's scroll to end like other size changes; the rows show them meanwhile.
    restore(!appended || trimmed);
    if (!stick && reachesEnd(logicalTop())) setStick(true);
    if (added.length > 0) {
      if (!stick) setUnseen((value) => value + added.length);
      queueAnnouncement(added);
    }
  };

  /**
   * Follows the end. With newer items not loaded, `onLoadNewest` replaces the items, after any running load; without
   * it, following the end keeps `onLoadNewer` paging until the newest item arrives or the reader scrolls away.
   */
  const scrollToEnd = () => {
    takeOver();
    setStick(!props.hasNewer || Boolean(props.onLoadNewer || props.onLoadNewest));
    if (props.hasNewer && props.onLoadNewest) loadNewest();
    if (hi < list.length) windowAround(list.length - 1);
    restore(true);
  };

  const scrollToKey = (key: string, options: VirtualFeedScrollOptions = {}) => {
    const index = keys.indexOf(key);
    if (index < 0) return false;
    takeOver();
    if (index < lo || index >= hi) windowAround(index);
    recompute();
    const delta = () => (options.align === "start" ? 0 : Math.max(0, (viewport.clientHeight - sizes[index]!) / 2));
    setStick(false);
    anchor = { index, delta: delta() };
    restore(true);
    // The row was measured while mounting, before this frame paints; center it on its real height.
    if (anchor.index === index && anchor.delta !== delta()) {
      anchor = { index, delta: delta() };
      restore(true);
    }
    if (reachesEnd(logicalTop())) setStick(true);
    if (options.highlight) {
      clearTimeout(highlightTimer);
      setHighlighted(key);
      highlightTimer = setTimeout(() => setHighlighted(undefined), HIGHLIGHT_MS);
    }
    return true;
  };

  const focusRow = (target: number) => {
    if (list.length === 0) return;
    const index = Math.min(list.length - 1, Math.max(0, target));
    // An edge load during the restore may add items synchronously and shift indices; the key keeps the target.
    const key = keys[index]!;
    const outside = index < lo || index >= hi;
    if (outside) windowAround(index);
    recompute();
    focusIndex = index;
    const top = logicalTop();
    const height = viewport.clientHeight;
    const start = offsetOf(index);
    const size = sizes[index]!;
    if (index === list.length - 1 && hi === list.length && !props.hasNewer) setStick(true);
    else if (outside) {
      setStick(false);
      anchor = { index, delta: 0 };
    } else if (start < top) {
      setStick(false);
      anchor = { index, delta: 0 };
    } else if (start + size > top + height) {
      setStick(false);
      anchor = { index, delta: Math.max(0, height - size) };
      restore(true);
      // The row was measured while mounting; align its real bottom before this frame paints.
      if (anchor.index === focusIndex) anchor = { index: focusIndex, delta: Math.max(0, height - sizes[focusIndex]!) };
    }
    restore(true);
    rows.get(key)?.node.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const row = rowOf.get(event.target as Element);
    if (!row) return;
    const index = row.index;
    if (event.key === "ArrowUp" || event.key === "PageUp") focusRow(index - 1);
    else if (event.key === "ArrowDown" || event.key === "PageDown") focusRow(index + 1);
    else if (event.key === "Home" && event.ctrlKey) focusRow(0);
    else if (event.key === "End" && event.ctrlKey) {
      scrollToEnd();
      focusRow(list.length - 1);
    } else return;
    event.preventDefault();
  };

  const onScroll = () => {
    // The feed checked its edges when it wrote scrollTop. Its own scroll event arrives a frame later, and checking again
    // then would retry a load that failed in between.
    const reader = noteReader();
    // Near the start, the rows no longer stand in for a held-back correction; it is written now.
    if (deferred !== 0 && !mayDefer(logicalTop())) restore(true);
    else {
      updateRange();
      if (reader) checkEdges();
    }
  };

  /**
   * Ends the reader's scroll if the feed stands still for the next two frames. A `scrollend` not counted as a write's
   * can still be the late one of an earlier write; movement after it means the scroll goes on.
   */
  const confirmEnd = () => {
    const seen = lastMove;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (disposed || fingers.size > 0 || !scrolling || lastMove !== seen || readerMoved()) return;
        endScroll();
      }),
    );
  };

  const onScrollEnd = () => {
    // The scrollend of the feed's own write, not the end of the reader's scroll.
    if (performance.now() < owedUntil) {
      owedUntil = 0;
      return;
    }
    endedAt = performance.now();
    if (fingers.size > 0 || !scrolling) return;
    confirmEnd();
  };

  const controller: VirtualFeedController = {
    scrollToKey,
    scrollToEnd,
    isAtEnd: () => stick,
  };

  // Created before the first sync below, so items that an edge load adds synchronously during it are not lost.
  createEffect(on(() => props.items, sync, { defer: true }));
  // More items can appear at an edge without new items, for example when a live update reports newer ones.
  createEffect(
    on(
      [() => props.hasOlder, () => props.hasNewer],
      () => {
        if (!props.hasNewer) endKey = keys[keys.length - 1];
        if (hi <= lo) return;
        if (!stick && reachesEnd(logicalTop())) setStick(true);
        // Only newer pages can be followed; with just `onLoadNewest`, "Jump to latest" has to show.
        else if (stick && props.hasNewer && !props.onLoadNewer) setStick(false);
        checkEdges();
      },
      { defer: true },
    ),
  );

  onMount(() => {
    hasScrollEnd = "onscrollend" in window;
    lastHeight = viewport.clientHeight;
    const observer = new ResizeObserver((entries) => {
      observing = true;
      try {
        // A scroll of the reader in this frame counts first, in the geometry from before these changes.
        noteReader();
        fresh = [];
        let resized = false;
        const measured: Array<readonly [HTMLElement, number]> = [];
        for (const entry of entries) {
          if (entry.target === viewport) {
            // A shorter viewport (a growing footer or keyboard) keeps what is at its bottom in place.
            const height = viewport.clientHeight;
            if (!stick) anchor = { index: anchor.index, delta: anchor.delta + height - lastHeight };
            lastHeight = height;
            resized = true;
          } else if (entry.target.isConnected) {
            const row = entry.target as HTMLElement;
            measured.push([row, entry.borderBoxSize?.[0]?.blockSize ?? row.getBoundingClientRect().height]);
          }
        }
        if (measure(measured) || resized) restore();
      } finally {
        observing = false;
      }
    });
    observer.observe(viewport);
    // Rows observed inside the observer's own callback miss its first notification, which raises a window error.
    // They were measured while mounting, so they are observed from the next frame on.
    let later: HTMLElement[] = [];
    let laterFrame = 0;
    observeRow = (row) => {
      if (!observing) return observer.observe(row);
      later.push(row);
      laterFrame ||= requestAnimationFrame(() => {
        laterFrame = 0;
        for (const node of later) if (node.isConnected) observer.observe(node);
        later = [];
      });
    };
    unobserveRow = (row) => observer.unobserve(row);
    const release = () => {
      for (const target of touched) {
        target.removeEventListener("touchend", touchEnd);
        target.removeEventListener("touchcancel", touchEnd);
      }
      touched.clear();
    };
    // Input of the reader ends a takeover by the application at once, and lets the feed scroll for that input.
    const act = () => {
      overriding = false;
      viewport.style.removeProperty("overflow-y");
    };
    const touchStart = (event: TouchEvent) => {
      // A touch whose end the feed missed has left the screen by now.
      const down = new Set(Array.from(event.touches, (touch) => touch.identifier));
      for (const id of fingers) if (!down.has(id)) fingers.delete(id);
      for (const touch of Array.from(event.changedTouches)) fingers.add(touch.identifier);
      act();
      // Touch events stay with the element the touch began on, also when the feed removes its row meanwhile.
      const target = event.target;
      if (target && !touched.has(target)) {
        touched.add(target);
        target.addEventListener("touchend", touchEnd, { passive: true });
        target.addEventListener("touchcancel", touchEnd, { passive: true });
      }
    };
    function touchEnd(event: Event) {
      for (const touch of Array.from((event as TouchEvent).changedTouches)) fingers.delete(touch.identifier);
      if (fingers.size > 0) return;
      release();
      // The last step of a short flick can have moved scrollTop before its scroll event; it counts before anything ends.
      if (!scrolling && !noteReader()) return endScroll();
      armEnd();
      // A scroll that ended under the finger ends now, unless the release starts a momentum.
      if (endedAt >= lastMove) confirmEnd();
    }
    viewport.addEventListener("touchstart", touchStart, { passive: true });
    viewport.addEventListener("scrollend", onScrollEnd);
    for (const type of ["wheel", "keydown", "pointerdown"]) viewport.addEventListener(type, act, { passive: true });
    onCleanup(() => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(laterFrame);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("scrollend", onScrollEnd);
      for (const type of ["wheel", "keydown", "pointerdown"]) viewport.removeEventListener(type, act);
      release();
      clearTimeout(endTimer);
      clearTimeout(announceTimer);
      clearTimeout(highlightTimer);
      for (const row of rows.values()) row.dispose();
      rows.clear();
    });
    sync(props.items);
    props.controller?.(controller);
  });

  const shownCount = () => props.newCount ?? unseen();

  return (
    <div class={props.class ? `k2b-virtual-feed ${props.class}` : "k2b-virtual-feed"}>
      <div ref={viewport} class="k2b-virtual-feed__viewport" tabindex="-1" onScroll={onScroll}>
        <div
          ref={feed}
          class="k2b-virtual-feed__feed"
          role="feed"
          aria-label={props.label}
          aria-busy={props.busy || loadingOlder() || loadingNewer() ? "true" : "false"}
          onKeyDown={onKeyDown}
          onFocusIn={(event) => {
            const node = (event.target as HTMLElement).closest(".k2b-virtual-feed__item");
            const row = node ? rowOf.get(node) : undefined;
            if (row) {
              focusIndex = row.index;
              setTabStop(focusIndex);
            }
          }}
          onFocusOut={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && !feed.contains(next)) focusIndex = -1;
          }}
        />
      </div>
      <Show when={count() === 0 && props.empty}>
        <div class="k2b-virtual-feed__empty">{props.empty}</div>
      </Show>
      <Show when={loadingOlder()}>
        <div class="k2b-virtual-feed__status" aria-hidden="true">
          <i class="ti ti-loader-2 k2b-spin" />
          {messages().loading}
        </div>
      </Show>
      <Show when={!atEnd() && count() > 0}>
        <button
          type="button"
          class="k2b-virtual-feed__end"
          aria-label={shownCount() > 0 ? messages().feedJumpToLatestCount({ count: shownCount() }) : undefined}
          onClick={() => {
            scrollToEnd();
            // The button disappears at the end; keep focus in the feed instead of the document.
            if (props.hasNewer) viewport.focus({ preventScroll: true });
            else focusRow(list.length - 1);
          }}
        >
          <i class={loadingNewer() ? "ti ti-loader-2 k2b-spin" : "ti ti-arrow-down"} aria-hidden="true" />
          {messages().feedJumpToLatest}
          <Show when={shownCount() > 0}>
            <span class="k2b-virtual-feed__count" aria-hidden="true">
              {shownCount()}
            </span>
          </Show>
        </button>
      </Show>
      <div ref={log} class="k2b-sr-only" role="log" aria-live="polite" aria-relevant="additions" />
    </div>
  );
}

export default VirtualFeed;
