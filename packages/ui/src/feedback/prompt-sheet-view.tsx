import { type JSX, onCleanup, onMount } from "solid-js";
import { suppressTextSelection } from "../internal/text-selection";
import { resolveUiMessages } from "../intl/messages";
import { sheetInitialFocus } from "../layout/bottom-sheet-options";
import { attachSheetMotion, type SheetMotion } from "../layout/sheet-motion";
import { type DialogRender, dialogCore, type OpenDialogOptions } from "./dialog-core";

// The phone presentation of prompts: loaded only when a prompt opens on a phone, so a page that never shows one as a
// sheet carries none of it.

function PromptSheet(props: { children: JSX.Element; canDismiss: boolean; dismiss: () => void | Promise<void> }) {
  let handle: HTMLButtonElement | undefined;
  let motion: SheetMotion | undefined;
  let releaseTextSelection: (() => void) | undefined;
  onMount(() => {
    const panel = handle?.parentElement;
    const frame = panel?.closest<HTMLElement>(".k2b-bottom-sheet-frame");
    if (!handle || !panel || !frame) return;
    const own = attachSheetMotion({
      frame,
      panel,
      handle,
      detents: false,
      canDismiss: () => props.canDismiss,
      dismiss: props.dismiss,
    });
    motion = own;
    // dialogCore opens the dialog in the same task, after this; the sheet measures itself open before the first frame.
    queueMicrotask(() => own.open());
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
    <>
      <button
        ref={handle}
        type="button"
        class="k2b-bottom-sheet__handle"
        aria-label={resolveUiMessages().close}
        disabled={!props.canDismiss}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          release();
          releaseTextSelection = suppressTextSelection(event.pointerId);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onClick={() => {
          // The press after a drag never gets here: the sheet's motion swallows that click.
          if (motion) motion.press();
          else void props.dismiss();
        }}
      >
        <span aria-hidden="true" />
      </button>
      {props.children}
    </>
  );
}

/** Opens the prompt as a bottom sheet; dismissing it, by its handle or a drag, takes the prompt's own dismiss path. */
export const openPromptSheet = <T,>(render: DialogRender<T>, options: OpenDialogOptions): Promise<T | undefined> =>
  dialogCore.open<T>(
    (close, context) => (
      <PromptSheet canDismiss={options.cancelBehavior !== "ignore"} dismiss={() => context.requestDismiss()}>
        {render(close, context)}
      </PromptSheet>
    ),
    {
      ...options,
      panelClassName: `${options.panelClassName ?? "k2b-dialog"} k2b-bottom-sheet-frame k2b-prompt-sheet`,
      contentClassName: `${options.contentClassName ?? ""} k2b-bottom-sheet-viewport`.trim(),
      initialFocus: options.initialFocus ?? sheetInitialFocus,
    },
  );
