import { type JSX, Show } from "solid-js";
import type { OpenDialogOptions } from "../feedback/dialog-core";
import { useUiMessages } from "../intl/messages";
import PanelDialog from "./PanelDialog";

export const bottomSheetOptions = {
  panelClassName: "k2b-dialog k2b-bottom-sheet-frame",
  contentClassName: "k2b-panel-dialog-viewport k2b-bottom-sheet-viewport",
} satisfies OpenDialogOptions;

export type BottomSheetProps = {
  children: JSX.Element;
  /** Pass dialogCore's render context requestDismiss, never the completion callback. */
  onDismiss: () => void | Promise<void>;
  dismissDisabled?: boolean;
  dismissLabel?: string;
  handle?: boolean;
};

function BottomSheetRoot(props: BottomSheetProps) {
  const messages = useUiMessages();
  let pointer: { id: number; y: number } | undefined;
  let suppressClick = false;
  const dismiss = () => {
    if (!props.dismissDisabled) void props.onDismiss();
  };
  return (
    <PanelDialog>
      <Show when={props.handle !== false}>
        <button
          type="button"
          class="k2b-bottom-sheet__handle"
          aria-label={props.dismissLabel ?? messages().close}
          disabled={props.dismissDisabled}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0 || props.dismissDisabled) return;
            suppressClick = false;
            pointer = { id: event.pointerId, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (pointer?.id !== event.pointerId) return;
            const distance = event.clientY - pointer.y;
            pointer = undefined;
            // A drag must not turn into a second dismiss request through click.
            suppressClick = Math.abs(distance) > 8;
            if (distance > 60) dismiss();
          }}
          onPointerCancel={() => {
            pointer = undefined;
            suppressClick = true;
          }}
          onLostPointerCapture={() => {
            if (pointer) {
              pointer = undefined;
              suppressClick = true;
            }
          }}
          onClick={(event) => {
            if (event.detail !== 0 && suppressClick) {
              suppressClick = false;
              return;
            }
            dismiss();
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
