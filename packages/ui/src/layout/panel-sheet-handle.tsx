import { type JSX, onCleanup, onMount } from "solid-js";
import { suppressTextSelection } from "../internal/text-selection";
import { useUiMessages } from "../intl/messages";
import { attachSheetMotion, type SheetMotion } from "./sheet-motion";

/**
 * Asks the dialog to close as Escape does, through its cancel event: its cancel behavior and guard decide. The promise
 * settles a frame later only if the sheet is still shown, so a guard that keeps it brings it back; a closed sheet
 * fades where it is.
 */
const requestClose = (frame: HTMLDialogElement, panel: HTMLElement) =>
  new Promise<void>((resolve) => {
    frame.dispatchEvent(new Event("cancel", { cancelable: true }));
    requestAnimationFrame(() => {
      if (frame.open && panel.isConnected && panel.offsetParent !== null) resolve();
    });
  });

/**
 * The grip of a `PanelDialog` that opened as a sheet below 48rem (K13, K16): the finger pulls the sheet down to close
 * it, a tap closes it, and it moves like a `BottomSheet`. `PanelDialog` renders it only when it opens on a phone.
 */
export function PanelSheetHandle(props: { frame: HTMLDialogElement }): JSX.Element {
  const messages = useUiMessages();
  let handle!: HTMLButtonElement;
  let motion: SheetMotion | undefined;
  let releaseTextSelection: (() => void) | undefined;
  onMount(() => {
    const panel = handle.parentElement;
    if (!panel) return;
    const own = attachSheetMotion({
      frame: props.frame,
      panel,
      handle,
      detents: false,
      canDismiss: () => true,
      dismiss: () => requestClose(props.frame, panel),
    });
    motion = own;
    queueMicrotask(() => own.open());
    // Turned to 48rem and wider, the dialog is centered again: the sheet's motion lets go of the frame.
    const wide = window.matchMedia("(min-width: 48rem)");
    const release = () => {
      if (!wide.matches) return;
      motion?.dispose();
      motion = undefined;
    };
    wide.addEventListener("change", release);
    onCleanup(() => wide.removeEventListener("change", release));
  });
  onCleanup(() => {
    releaseTextSelection?.();
    motion?.dispose();
  });
  const release = () => {
    releaseTextSelection?.();
    releaseTextSelection = undefined;
  };
  return (
    <button
      ref={handle}
      type="button"
      class="k2b-bottom-sheet__handle"
      aria-label={messages().close}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        release();
        releaseTextSelection = suppressTextSelection(event.pointerId);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={() => motion?.press()}
    >
      <span aria-hidden="true" />
    </button>
  );
}
