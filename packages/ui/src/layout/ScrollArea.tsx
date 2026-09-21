import { type JSX, splitProps } from "solid-js";
import { createScrollFade } from "./scroll-fade";

export type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "children" | "class"> & {
  children: JSX.Element;
  scrollFade?: boolean;
  /** Stable compact catalog height, clamped to 60% of the dynamic viewport. */
  viewportSize?: "compact";
  orientation?: "vertical" | "horizontal";
  scrollPreserveKey?: string | false;
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
    "ref",
  ]);
  let body!: HTMLDivElement;
  createScrollFade(
    () => body,
    () => local.scrollFade !== false,
  );
  const className = () => local.class?.trim();

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
      data-scroll-fade-mode={local.scrollFade !== false ? "both" : undefined}
      class={className() ? `k2b-scroll-area ${className()}` : "k2b-scroll-area"}
      data-scroll-preserve={local.scrollPreserveKey || undefined}
    >
      {local.children}
    </div>
  );
}

export default ScrollArea;
