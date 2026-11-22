/**
 * The flat scrollbar (Cloud flach, K2): a scroller marked `data-scrollbar="overlay"` reserves no scroll track. Its
 * content takes the whole width, so row lines and fills reach the area's edge, and nothing shifts when the content
 * starts or stops to overflow, in Chromium and in WebKit. With a mouse a thin thumb of its own stands over the content
 * at the end edge; CSS hides the native scrollbar there. Touch screens and forced colors keep the native scrollbar,
 * and CSS shows no thumb for them. Keyboard scrolling, focus scrolling and what screen readers get stay the browser's:
 * the scroller is unchanged, and the thumb is hidden from assistive technology.
 *
 * Plain DOM, no Solid: `ScrollArea` attaches it when it mounts, and the workspace controller attaches it to the
 * server-rendered columns (main, panes, detail, sidebar) on their first hover, scroll or focus.
 */

const attached = new WeakMap<HTMLElement, () => void>();
const OVERLAY = "k2b-overlay-scrollbar";

/** Attaches the overlay thumb to one scroller, once; returns the cleanup. */
export function attachOverlayScrollbar(scroller: HTMLElement): () => void {
  const known = attached.get(scroller);
  if (known) return known;
  // An island bundles its own copy of this module, so the map above does not see every thumb. The DOM does: a second
  // thumb would fight the first for the front place, one mutation after the other, and hang the page.
  if (scroller.querySelector(`:scope > .${OVERLAY}`)) return () => {};
  const overlay = document.createElement("div");
  overlay.className = OVERLAY;
  overlay.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  thumb.className = `${OVERLAY}__thumb`;
  overlay.append(thumb);
  let size = 0;
  let frame = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  // The overlay is a zero-height sticky line at the top of the scrollport; a renderer that replaces the scroller's
  // children may drop it, so it goes back in front of them.
  const place = () => {
    if (overlay.parentElement !== scroller || scroller.firstElementChild !== overlay) scroller.prepend(overlay);
  };
  // The overlay is an item of a flex scroller too, so the scroller's gap would stand after it and move every row by
  // that gap the moment the thumb arrives. A negative margin of the same size takes that room back.
  const cancelGap = () => {
    const style = getComputedStyle(scroller);
    const column = style.flexDirection.startsWith("column");
    const gap = column ? style.rowGap : style.columnGap;
    const flex = style.display.endsWith("flex") && gap !== "normal";
    overlay.style.marginBlockEnd = flex && column ? `calc(-1 * ${gap})` : "";
    overlay.style.marginInlineEnd = flex && !column ? `calc(-1 * ${gap})` : "";
  };
  const measure = () => {
    frame = 0;
    cancelGap();
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (range <= 1) {
      overlay.removeAttribute("data-overflow");
      return;
    }
    size = Math.max(32, (scroller.clientHeight * scroller.clientHeight) / scroller.scrollHeight);
    const offset = (scroller.scrollTop / range) * (scroller.clientHeight - size);
    overlay.setAttribute("data-overflow", "true");
    overlay.style.setProperty("--k2b-scroll-thumb-offset", `${offset}px`);
    overlay.style.setProperty("--k2b-scroll-thumb-size", `${size}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const onScroll = () => {
    schedule();
    scroller.setAttribute("data-scrolling", "true");
    clearTimeout(idle);
    idle = setTimeout(() => scroller.removeAttribute("data-scrolling"), 800);
  };
  const resize = new ResizeObserver(schedule);
  const observeChildren = () => {
    resize.disconnect();
    resize.observe(scroller);
    for (const child of Array.from(scroller.children)) resize.observe(child);
  };
  const mutations = new MutationObserver(() => {
    place();
    observeChildren();
    schedule();
  });
  // Dragging the thumb scrolls the area by the same share of its range.
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !overlay.hasAttribute("data-overflow")) return;
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    thumb.setAttribute("data-dragging", "true");
    const start = { y: event.clientY, top: scroller.scrollTop };
    const ratio = (scroller.scrollHeight - scroller.clientHeight) / Math.max(1, scroller.clientHeight - size);
    const move = (next: PointerEvent) => {
      scroller.scrollTop = start.top + (next.clientY - start.y) * ratio;
    };
    const end = () => {
      thumb.removeAttribute("data-dragging");
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", end);
      thumb.removeEventListener("pointercancel", end);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
  };
  place();
  observeChildren();
  mutations.observe(scroller, { childList: true });
  scroller.addEventListener("scroll", onScroll, { passive: true });
  thumb.addEventListener("pointerdown", onPointerDown);
  measure();
  const dispose = () => {
    attached.delete(scroller);
    scroller.removeEventListener("scroll", onScroll);
    thumb.removeEventListener("pointerdown", onPointerDown);
    resize.disconnect();
    mutations.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    scroller.removeAttribute("data-scrolling");
    overlay.remove();
  };
  attached.set(scroller, dispose);
  return dispose;
}

/**
 * Attaches the thumb to every overlay scroller under `root` the first time a person points at it, scrolls it, or moves
 * focus into it, so server-rendered columns get their thumb without code of their own and without a page-wide
 * observer. Returns the cleanup of the listeners; attached thumbs stay with their scrollers.
 */
export function installOverlayScrollbars(root: Document | HTMLElement = document): () => void {
  const attach = (event: Event) => {
    const target = event.target;
    const element = target instanceof Element ? target : null;
    const scroller = element?.closest<HTMLElement>('[data-scrollbar="overlay"]');
    if (scroller && !attached.has(scroller)) attachOverlayScrollbar(scroller);
  };
  root.addEventListener("pointerover", attach, { passive: true });
  root.addEventListener("focusin", attach);
  // Scroll events do not bubble; the capture phase sees them all.
  root.addEventListener("scroll", attach, { capture: true, passive: true });
  return () => {
    root.removeEventListener("pointerover", attach);
    root.removeEventListener("focusin", attach);
    root.removeEventListener("scroll", attach, { capture: true });
  };
}
