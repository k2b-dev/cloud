import { createEffect, onCleanup, onMount } from "solid-js";
import { attachResizeSeparator, type ResizeSeparatorOptions } from "./resize-separator";

export type ResizeSeparatorProps = Omit<ResizeSeparatorOptions, "value"> & {
  label: string;
  orientation: "vertical" | "horizontal";
  value: number;
  controls?: string;
  class?: string;
};

export default function ResizeSeparator(props: ResizeSeparatorProps) {
  let element: HTMLDivElement | undefined;
  onMount(() => {
    if (element)
      onCleanup(
        attachResizeSeparator(element, {
          get min() {
            return props.min;
          },
          get max() {
            return props.max;
          },
          value: () => props.value,
          get unit() {
            return props.unit;
          },
          get step() {
            return props.step;
          },
          get largeStep() {
            return props.largeStep;
          },
          get grow() {
            return props.grow;
          },
          get collapseBelow() {
            return props.collapseBelow;
          },
          onResize: (value) => props.onResize(value),
          onResizeEnd: (value) => props.onResizeEnd?.(value),
          get onReset() {
            return props.onReset;
          },
          onCollapseIntent: (armed) => props.onCollapseIntent?.(armed),
          onCollapse: () => props.onCollapse?.(),
          onDragChange: (dragging) => props.onDragChange?.(dragging),
        }),
      );
  });
  createEffect(() => {
    if (element) element.setAttribute("aria-valuenow", String(Math.round(props.value * 100) / 100));
  });
  return (
    <div
      ref={element}
      role="separator"
      tabindex="0"
      class={`k2b-resize-separator${props.class ? ` ${props.class}` : ""}`}
      aria-orientation={props.orientation}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={Math.round(props.value * 100) / 100}
      aria-label={props.label}
      aria-controls={props.controls}
      data-orientation={props.orientation}
      // A separator that grows toward the start sits on the start edge of the region it resizes; the drag cue shades that region.
      data-resize-edge={props.grow === "start" ? "start" : "end"}
    >
      <span aria-hidden="true" />
    </div>
  );
}
