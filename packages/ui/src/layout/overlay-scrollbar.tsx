import { createSignal, type JSX, onCleanup, onMount } from "solid-js";

/**
 * The overlay scrollbar of a flat scroller (Cloud flach K2): the scroller reserves no track, so its rows, lines, and
 * fills reach the column edge and nothing moves when content starts or stops overflowing, in Chromium and WebKit
 * alike. With a mouse this thin thumb stands over the content at the end edge while the pointer is over the scroller or
 * it scrolls, and dragging it scrolls. Touch screens keep their native overlay scrollbar and forced colors the system
 * one (layout-parity.css). It is the scroller's last child: a zero-high line that sticks to the bottom of the
 * scrollport, so it takes no room and no sibling rule of the content sees it before the content.
 */
export function OverlayScrollbar(props: { scroller: () => HTMLElement | undefined }): JSX.Element {
  const [thumb, setThumb] = createSignal<{ top: number; size: number; right: number } | null>(null);
  let frame = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    frame = 0;
    const element = props.scroller();
    if (!element) return;
    const range = element.scrollHeight - element.clientHeight;
    if (range <= 1) return setThumb(null);
    const size = Math.max(32, (element.clientHeight * element.clientHeight) / element.scrollHeight);
    const offset = (element.scrollTop / range) * (element.clientHeight - size);
    // The line sits at the bottom of the scrollport's content box; the thumb stands from the top of the scrollport,
    // at its end edge past any end padding.
    const style = getComputedStyle(element);
    setThumb({
      top: offset - element.clientHeight + Number.parseFloat(style.paddingBottom),
      size,
      right: -Number.parseFloat(style.paddingRight),
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  onMount(() => {
    const element = props.scroller();
    if (!element) return;
    const onScroll = () => {
      schedule();
      element.dataset.scrolling = "true";
      clearTimeout(idle);
      idle = setTimeout(() => delete element.dataset.scrolling, 800);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(schedule);
    const observeChildren = () => {
      for (const child of Array.from(element.children)) resize.observe(child);
    };
    resize.observe(element);
    observeChildren();
    const mutations = new MutationObserver(() => {
      observeChildren();
      schedule();
    });
    mutations.observe(element, { childList: true });
    measure();
    onCleanup(() => {
      element.removeEventListener("scroll", onScroll);
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(idle);
      delete element.dataset.scrolling;
    });
  });
  /** Dragging the thumb scrolls the area by the same share of its range. */
  const drag = (event: PointerEvent) => {
    const element = props.scroller();
    const current = thumb();
    if (!element || !current || event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const start = { y: event.clientY, top: element.scrollTop };
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";
    const ratio = (element.scrollHeight - element.clientHeight) / Math.max(1, element.clientHeight - current.size);
    const move = (next: PointerEvent) => {
      element.scrollTop = start.top + (next.clientY - start.y) * ratio;
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
  return (
    <div class="k2b-overlay-scrollbar" aria-hidden="true" data-overflow={thumb() ? "true" : undefined}>
      <span
        class="k2b-overlay-scrollbar__thumb"
        style={{
          top: `${thumb()?.top ?? 0}px`,
          right: `${thumb()?.right ?? 0}px`,
          height: `${thumb()?.size ?? 0}px`,
        }}
        on:pointerdown={drag}
      />
    </div>
  );
}
