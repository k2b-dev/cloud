import { createEffect, createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { createHoverPreview, HoverPreview } from "../feedback/HoverPreview";
import { ScrollArea, type ScrollAreaProps } from "./ScrollArea";

/** A non-modal, interactive row preview built on the shared hover preview card. */
export function SidebarItemPreview(props: {
  label: string;
  children: JSX.Element | ((close: () => void) => JSX.Element);
  trigger?: "action" | "row";
  align?: "center" | "end";
  viewportSize?: ScrollAreaProps["viewportSize"];
  /** The row's metadata; a row trigger, named by `label`, keeps it as its description. */
  describedBy?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  let main: HTMLButtonElement | null = null;
  const preview = createHoverPreview<true>({
    keyboard: "focus",
    placement: {
      get align() {
        return props.align;
      },
    },
    onOpenChange: (visible) => {
      setOpen(visible);
      main?.setAttribute("aria-expanded", String(visible));
      props.onOpenChange?.(visible);
    },
  });
  const toggle = () => preview.toggle(true);
  onMount(() => {
    const row = button.closest<HTMLElement>(".k2b-app-workspace__sidebar-item");
    if (props.trigger === "row") {
      main = row?.querySelector<HTMLButtonElement>(":scope > button.k2b-app-workspace__sidebar-item-main") ?? null;
      main?.setAttribute("aria-label", props.label);
      main?.setAttribute("aria-haspopup", "dialog");
      main?.setAttribute("aria-controls", preview.id);
      main?.setAttribute("aria-expanded", "false");
      main?.addEventListener("click", toggle);
    }
    preview.anchor(true, () => main ?? button)(row ?? button);
    onCleanup(() => main?.removeEventListener("click", toggle));
  });
  createEffect(() => {
    const id = props.describedBy;
    if (id) main?.setAttribute("aria-describedby", id);
    else main?.removeAttribute("aria-describedby");
  });
  return (
    <>
      <button
        ref={button}
        type="button"
        class="k2b-app-workspace__sidebar-item-action k2b-app-workspace__sidebar-preview-trigger"
        data-visibility="hover"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={preview.id}
        data-row-trigger={props.trigger === "row" ? "true" : undefined}
        onClick={toggle}
      >
        <i class={props.trigger === "row" ? "ti ti-chevron-right" : "ti ti-info-circle"} aria-hidden="true" />
      </button>
      <HoverPreview preview={preview} label={props.label} class="k2b-app-workspace__sidebar-preview">
        <ScrollArea viewportSize={props.viewportSize} class="k2b-app-workspace__sidebar-preview-body">
          {typeof props.children === "function" ? props.children(preview.close) : props.children}
        </ScrollArea>
      </HoverPreview>
    </>
  );
}
