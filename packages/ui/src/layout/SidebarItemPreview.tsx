import { ScrollArea } from "./ScrollArea";
import { createSignal, createUniqueId, type JSX, onCleanup, onMount } from "solid-js";
import { positionTooltipSurface } from "../feedback/tooltip-position";

/** A non-modal, interactive row preview. Native popover owns light dismissal. */
export function SidebarItemPreview(props: { label: string; children: JSX.Element | ((close: () => void) => JSX.Element); trigger?: "action" | "row"; onOpenChange?: (open: boolean) => void }) {
  const id = `sidebar-preview-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let row: HTMLElement | null = null;
  let main: HTMLButtonElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pinned = false;
  let dismissed = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const close = () => { clear(); panel.hidePopover(); };
  const show = () => {
    clear();
    if (dismissed || open()) return;
    panel.showPopover();
    positionTooltipSurface(panel, row ?? button, "right");
  };
  const enter = () => { clear(); if (!dismissed && !open()) timer = setTimeout(show, 250); };
  const leave = () => {
    clear();
    dismissed = false;
    if (!pinned) timer = setTimeout(() => {
      if (!panel.contains(document.activeElement) && !row?.contains(document.activeElement)) close();
    }, 180);
  };
  const dismiss = () => {
    const restore = panel.contains(document.activeElement);
    dismissed = true;
    close();
    if (restore) (main ?? button).focus();
  };
  const toggle = () => {
    clear();
    if (open() && pinned) { dismiss(); return; }
    dismissed = false; pinned = true; show(); panel.focus();
  };
  onMount(() => {
    row = button.closest<HTMLElement>(".k2b-app-workspace__sidebar-item");
    if (props.trigger === "row") {
      main = row?.querySelector<HTMLButtonElement>(":scope > button.k2b-app-workspace__sidebar-item-main") ?? null;
      main?.setAttribute("aria-label", props.label);
      main?.setAttribute("aria-haspopup", "dialog");
      main?.setAttribute("aria-controls", id);
      main?.setAttribute("aria-expanded", "false");
      main?.addEventListener("click", toggle);
    }
    const pointerEnter = (event: PointerEvent) => { if (event.pointerType === "mouse") enter(); };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (panel.contains(next) || row?.contains(next))) return;
      pinned = false;
      leave();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open()) return;
      dismiss();
    };
    const reposition = () => { if (open()) positionTooltipSurface(panel, row ?? button, "right"); };
    row?.addEventListener("pointerenter", pointerEnter);
    row?.addEventListener("pointerleave", leave);
    row?.addEventListener("focusin", enter);
    row?.addEventListener("focusout", focusOut);
    panel.addEventListener("focusout", focusOut);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer = new ResizeObserver(reposition);
    observer.observe(panel);
    onCleanup(() => {
      clear(); observer.disconnect();
      main?.removeEventListener("click", toggle);
      row?.removeEventListener("pointerenter", pointerEnter);
      row?.removeEventListener("pointerleave", leave);
      row?.removeEventListener("focusin", enter);
      row?.removeEventListener("focusout", focusOut);
      panel.removeEventListener("focusout", focusOut);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    });
  });
  return <>
    <button ref={button} type="button" class="k2b-app-workspace__sidebar-item-action k2b-app-workspace__sidebar-preview-trigger"
      data-visibility="hover" aria-label={props.label} aria-haspopup="dialog" aria-expanded={open()} aria-controls={id}
      data-row-trigger={props.trigger === "row" ? "true" : undefined}
      onClick={toggle}><i class={props.trigger === "row" ? "ti ti-chevron-right" : "ti ti-info-circle"} aria-hidden="true" /></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={props.label} tabIndex={-1}
      class="k2b-app-workspace__sidebar-preview" onPointerEnter={clear} onPointerLeave={leave}
      onToggle={(event) => { const visible = event.newState === "open"; setOpen(visible); main?.setAttribute("aria-expanded", String(visible)); props.onOpenChange?.(visible); if (!visible) pinned = false; }}>
      <ScrollArea class="k2b-app-workspace__sidebar-preview-body">
        {typeof props.children === "function" ? props.children(dismiss) : props.children}
      </ScrollArea>
    </div>
  </>;
}
