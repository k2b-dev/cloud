import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { DialogTone } from "../feedback/dialog-tone";
import { suppressTextSelection } from "../internal/text-selection";
import { useUiMessages } from "../intl/messages";
import PanelDialog from "./PanelDialog";
import { attachSheetMotion, type SheetDetent, type SheetMotion } from "./sheet-motion";

export { bottomSheetAdaptiveOptions, bottomSheetOptions } from "./bottom-sheet-options";

export type BottomSheetProps = {
  children: JSX.Element;
  /** Pass dialogCore's render context requestDismiss, never the completion callback. */
  onDismiss: () => void | Promise<void>;
  dismissDisabled?: boolean;
  dismissLabel?: string;
  handle?: boolean;
  /**
   * Opens at half height, as a preview, and rests at half or full height. The handle, a drag, scrolling, or Tab into
   * the body moves it up; the footer stays on the screen's edge. Without it, the sheet rests at its content's height,
   * as menus and date sheets do.
   */
  detents?: boolean;
  /** See `PanelDialog`'s `tone`. */
  tone?: DialogTone;
};

function BottomSheetRoot(props: BottomSheetProps) {
  const messages = useUiMessages();
  const [detent, setDetent] = createSignal<SheetDetent>("half");
  let handle: HTMLButtonElement | undefined;
  let motion: SheetMotion | undefined;
  let releaseTextSelection: (() => void) | undefined;
  const dismiss = () => {
    if (!props.dismissDisabled) void props.onDismiss();
  };
  onMount(() => {
    const panel = handle?.parentElement;
    const frame = panel?.closest<HTMLElement>(".k2b-bottom-sheet-frame");
    if (!handle || !panel || !frame) return;
    const own = attachSheetMotion({
      frame,
      panel,
      handle,
      detents: props.detents === true,
      canDismiss: () => !props.dismissDisabled,
      dismiss: () => props.onDismiss(),
      onDetent: setDetent,
    });
    motion = own;
    // dialogCore opens the dialog in the same task, after this; the sheet measures itself open before the first frame.
    queueMicrotask(() => own.open());
  });
  onCleanup(() => {
    releaseTextSelection?.();
    motion?.dispose();
  });
  const label = () => {
    if (props.detents) return detent() === "full" ? messages().sheetShrink : messages().sheetExpand;
    return props.dismissLabel ?? messages().close;
  };
  return (
    <PanelDialog tone={props.tone}>
      <Show when={props.handle !== false}>
        <button
          ref={handle}
          type="button"
          class="k2b-bottom-sheet__handle"
          aria-label={label()}
          aria-keyshortcuts={props.detents ? "ArrowUp ArrowDown" : undefined}
          disabled={props.dismissDisabled && !props.detents}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            releaseTextSelection?.();
            releaseTextSelection = suppressTextSelection(event.pointerId);
          }}
          onPointerUp={() => {
            releaseTextSelection?.();
            releaseTextSelection = undefined;
          }}
          onPointerCancel={() => {
            releaseTextSelection?.();
            releaseTextSelection = undefined;
          }}
          onKeyDown={(event) => {
            if (!props.detents || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            motion?.step(event.key === "ArrowUp" ? "up" : "down");
          }}
          onClick={() => {
            // The press after a drag never gets here: the sheet's motion swallows that click.
            if (motion) motion.press();
            else dismiss();
          }}
        >
          <span aria-hidden="true" />
        </button>
      </Show>
      {props.children}
    </PanelDialog>
  );
}

/** Bottom-edge presentation; dialogCore continues to own all modal state. */
const BottomSheet = Object.assign(BottomSheetRoot, {
  Header: PanelDialog.Header,
  Body: PanelDialog.Body,
  Footer: PanelDialog.Footer,
  Section: PanelDialog.Section,
  Tabs: PanelDialog.Tabs,
});
export default BottomSheet;
