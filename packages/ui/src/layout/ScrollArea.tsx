import { type JSX, Show, splitProps } from "solid-js";
import { OverlayScrollbar } from "./overlay-scrollbar";
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
  const overlay = () => local.scrollbar === "overlay" && local.orientation !== "horizontal";

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
      data-scrollbar={overlay() ? "overlay" : undefined}
      data-scroll-fade-mode={local.scrollFade !== false ? "both" : undefined}
      class={className() ? `k2b-scroll-area ${className()}` : "k2b-scroll-area"}
      data-scroll-preserve={local.scrollPreserveKey || undefined}
    >
      {local.children}
      <Show when={overlay()}>
        <OverlayScrollbar scroller={() => body} />
      </Show>
    </div>
  );
}

export default ScrollArea;
