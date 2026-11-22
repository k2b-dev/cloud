import { createSignal, type JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { createScrollFade } from "./scroll-fade";

export type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "children" | "class"> & {
  children: JSX.Element;
  scrollFade?: boolean;
  /** Stable compact catalog height, clamped to 60% of the dynamic viewport. */
  viewportSize?: "compact";
  orientation?: "vertical" | "horizontal";
  scrollPreserveKey?: string | false;
  /** Keep 0.5 rem inside both side edges, like a workspace column; with a mouse the end one is a fixed scroll track. */
  inset?: boolean;
  /**
   * `track` (default): with a mouse a fixed 0.5 rem scroll track at the end, so content never narrows when it starts to
   * scroll. `overlay`: no track; the content takes the whole width, so row lines and fills reach the area's edge, and a
   * thin thumb is drawn above the content (vertical only). Touch screens keep their native overlay scrollbars either way.
   */
  scrollbar?: "track" | "overlay";
  class?: string;
};

/** The overlay thumb: where it stands and how long it is, from the scroller's own measurements. */
function createOverlayThumb(body: () => HTMLDivElement) {
  const [thumb, setThumb] = createSignal<{ offset: number; size: number } | null>(null);
  const [scrolling, setScrolling] = createSignal(false);
  let frame = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    frame = 0;
    const element = body();
    const range = element.scrollHeight - element.clientHeight;
    if (range <= 1) return setThumb(null);
    const size = Math.max(32, (element.clientHeight * element.clientHeight) / element.scrollHeight);
    setThumb({ offset: (element.scrollTop / range) * (element.clientHeight - size), size });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  onMount(() => {
    const element = body();
    const onScroll = () => {
      schedule();
      setScrolling(true);
      clearTimeout(idle);
      idle = setTimeout(() => setScrolling(false), 800);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    for (const child of Array.from(element.children)) resize.observe(child);
    const mutations = new MutationObserver(() => {
      for (const child of Array.from(element.children)) resize.observe(child);
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
    });
  });
  /** Dragging the thumb scrolls the area by the same share of its range. */
  const drag = (event: PointerEvent) => {
    const element = body();
    const handle = event.currentTarget as HTMLElement;
    const start = { y: event.clientY, top: element.scrollTop };
    const current = thumb();
    if (!current || event.button !== 0) return;
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
  return { thumb, scrolling, drag };
}

export function ScrollArea(props: ScrollAreaProps): JSX.Element {
  const [local, elementProps] = splitProps(props, [
    "children",
    "scrollPreserveKey",
    "class",
    "scrollFade",
    "orientation",
    "viewportSize",
    "inset",
    "scrollbar",
    "ref",
  ]);
  let body!: HTMLDivElement;
  createScrollFade(
    () => body,
    () => local.scrollFade !== false,
  );
  const className = () => local.class?.trim();
  const overlay = local.scrollbar === "overlay" && local.orientation !== "horizontal";
  const overlayThumb = overlay ? createOverlayThumb(() => body) : undefined;

  return (
    <div
      {...elementProps}
      ref={(el) => {
        body = el;
        if (typeof local.ref === "function") local.ref(el);
      }}
      data-scroll-fade-axis={local.orientation ?? "vertical"}
      data-viewport-size={local.viewportSize}
      data-orientation={local.orientation ?? "vertical"}
      data-inset={local.inset ? "true" : undefined}
      data-scrollbar={overlay ? "overlay" : undefined}
      data-scrolling={overlayThumb?.scrolling() ? "true" : undefined}
      data-scroll-fade-mode={local.scrollFade !== false ? "both" : undefined}
      class={className() ? `k2b-scroll-area ${className()}` : "k2b-scroll-area"}
      data-scroll-preserve={local.scrollPreserveKey || undefined}
    >
      <Show when={overlayThumb}>
        {(thumb) => (
          // A zero-height sticky line at the top of the scrollport: it takes no room, and the thumb inside it stands
          // over the content at the area's end edge.
          <div class="k2b-scroll-area__overlay" aria-hidden="true" data-overflow={thumb().thumb() ? "true" : undefined}>
            <span
              class="k2b-scroll-area__thumb"
              style={{
                "--k2b-scroll-thumb-offset": `${thumb().thumb()?.offset ?? 0}px`,
                "--k2b-scroll-thumb-size": `${thumb().thumb()?.size ?? 0}px`,
              }}
              onPointerDown={thumb().drag}
            />
          </div>
        )}
      </Show>
      {local.children}
    </div>
  );
}

export default ScrollArea;
