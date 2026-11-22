import { type JSX, onCleanup, onMount } from "solid-js";

/**
 * The overlay scrollbar of a flat scroller (Cloud flach K2): the scroller (`data-scrollbar="overlay"`) reserves no
 * track, so its rows, lines, and fills reach the column edge and nothing moves when content starts or stops
 * overflowing, in Chromium and WebKit alike. With a mouse a thin thumb stands over the content at the end edge while
 * the pointer is over the scroller or it scrolls, and dragging it scrolls. Touch screens keep their native overlay
 * scrollbar and forced colors the system one (layout-parity.css).
 *
 * The markup is the scroller's last child, rendered on the server too: a zero-high line that sticks to the bottom of
 * the scrollport, so it takes no room and no sibling rule of the content sees it before the content. The thumb is
 * driven from the DOM, not from component state, so a server-rendered workspace gets it through
 * `installOverlayScrollbars` (the workspace controller installs it) and a client-rendered scroller through the
 * component itself.
 */
export function OverlayScrollbar(props: { scroller: () => HTMLElement | undefined }): JSX.Element {
  onMount(() => {
    const scroller = props.scroller();
    if (scroller) onCleanup(observeOverlayScrollbar(scroller));
  });
  return (
    <div class="k2b-overlay-scrollbar" aria-hidden="true">
      <span class="k2b-overlay-scrollbar__thumb" />
    </div>
  );
}

const selector = '[data-scrollbar="overlay"]';
const active = new WeakMap<HTMLElement, { users: number; stop: () => void }>();

const thumbOf = (scroller: HTMLElement) => {
  const line = scroller.lastElementChild;
  return line?.classList.contains("k2b-overlay-scrollbar") ? (line as HTMLElement) : null;
};

/** Drives the overlay thumb of one scroller until the returned stop is called. */
export function observeOverlayScrollbar(scroller: HTMLElement): () => void {
  const existing = active.get(scroller);
  if (existing) {
    existing.users += 1;
    return () => release(scroller);
  }
  let frame = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let size = 0;
  const measure = () => {
    frame = 0;
    const line = thumbOf(scroller);
    const thumb = line?.firstElementChild as HTMLElement | null | undefined;
    if (!line || !thumb) return;
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (range <= 1) {
      if (line.hasAttribute("data-overflow")) line.removeAttribute("data-overflow");
      return;
    }
    size = Math.max(32, (scroller.clientHeight * scroller.clientHeight) / scroller.scrollHeight);
    const offset = (scroller.scrollTop / range) * (scroller.clientHeight - size);
    // The line sits at the bottom of the scrollport's content box; the thumb stands from the top of the scrollport, at
    // its end edge past any end padding.
    const style = getComputedStyle(scroller);
    thumb.style.top = `${offset - scroller.clientHeight + Number.parseFloat(style.paddingBottom)}px`;
    thumb.style.right = `${-Number.parseFloat(style.paddingRight)}px`;
    thumb.style.height = `${size}px`;
    if (line.getAttribute("data-overflow") !== "true") line.setAttribute("data-overflow", "true");
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const onScroll = () => {
    schedule();
    scroller.dataset.scrolling = "true";
    clearTimeout(idle);
    idle = setTimeout(() => delete scroller.dataset.scrolling, 800);
  };
  /** Dragging the thumb scrolls the scroller by the same share of its range. */
  const onPointerDown = (event: PointerEvent) => {
    const handle = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".k2b-overlay-scrollbar__thumb") : null;
    if (!handle || handle.parentElement !== thumbOf(scroller) || event.button !== 0) return;
    const start = { y: event.clientY, top: scroller.scrollTop };
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    const ratio = (scroller.scrollHeight - scroller.clientHeight) / Math.max(1, scroller.clientHeight - size);
    const move = (next: PointerEvent) => {
      scroller.scrollTop = start.top + (next.clientY - start.y) * ratio;
    };
    const end = () => {
      delete handle.dataset.dragging;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("pointerdown", onPointerDown);
  const resize = new ResizeObserver(schedule);
  const observeChildren = () => {
    for (const child of Array.from(scroller.children)) resize.observe(child);
  };
  resize.observe(scroller);
  observeChildren();
  const mutations = new MutationObserver(() => {
    observeChildren();
    schedule();
  });
  mutations.observe(scroller, { childList: true });
  measure();
  active.set(scroller, {
    users: 1,
    stop: () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("pointerdown", onPointerDown);
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(idle);
      delete scroller.dataset.scrolling;
    },
  });
  return () => release(scroller);
}

function release(scroller: HTMLElement) {
  const entry = active.get(scroller);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  entry.stop();
  active.delete(scroller);
}

/** Drives every overlay scrollbar under `root`, including server-rendered ones and those a later navigation adds. */
export function installOverlayScrollbars(root: Document | HTMLElement): () => void {
  const owned = new Map<HTMLElement, () => void>();
  const sync = () => {
    const next = new Set(Array.from(root.querySelectorAll<HTMLElement>(selector)));
    if (root instanceof HTMLElement && root.matches(selector)) next.add(root);
    for (const [element, stop] of owned)
      if (!next.has(element)) {
        stop();
        owned.delete(element);
      }
    for (const element of next) if (!owned.has(element)) owned.set(element, observeOverlayScrollbar(element));
  };
  const containsScroller = (node: Node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector));
  const mutations = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === "attributes" ||
          Array.from(record.addedNodes).some(containsScroller) ||
          Array.from(record.removedNodes).some(containsScroller),
      )
    )
      sync();
  });
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-scrollbar"] });
  sync();
  return () => {
    mutations.disconnect();
    for (const stop of owned.values()) stop();
    owned.clear();
  };
}
