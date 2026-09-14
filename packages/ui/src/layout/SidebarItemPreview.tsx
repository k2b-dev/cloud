import { createSignal, createUniqueId, type JSX, onCleanup, onMount } from "solid-js";
import { positionTooltipSurface } from "../feedback/tooltip-position";

/** A non-modal, interactive row preview. Native popover owns light dismissal. */
export function SidebarItemPreview(props: { label: string; children: JSX.Element }) {
  const id = `sidebar-preview-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let row: HTMLElement | null = null;
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
  onMount(() => {
    row = button.closest<HTMLElement>(".k2b-app-workspace__sidebar-item");
    const pointerEnter = (event: PointerEvent) => { if (event.pointerType === "mouse") enter(); };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (panel.contains(next) || row?.contains(next))) return;
      pinned = false;
      leave();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open()) return;
      const restore = panel.contains(document.activeElement);
      dismissed = true;
      close();
      if (restore) button.focus();
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
      onClick={() => {
        clear();
        if (open() && pinned) { close(); return; }
        dismissed = false; pinned = true; show(); panel.focus();
      }}><i class="ti ti-info-circle" aria-hidden="true" /></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={props.label} tabIndex={-1}
      class="k2b-app-workspace__sidebar-preview" onPointerEnter={clear} onPointerLeave={leave}
      onToggle={(event) => { const visible = event.newState === "open"; setOpen(visible); if (!visible) pinned = false; }}>
      {props.children}
    </div>
  </>;
}
