import { type JSX, onCleanup, onMount } from "solid-js";
import { PHONE_SHEET_QUERY } from "../actions/phone-sheet";
import { suppressTextSelection } from "../internal/text-selection";
import { resolveUiMessages } from "../intl/messages";
import { attachSheetMotion, type SheetMotion, sheetInitialFocus } from "../layout/sheet-motion";
import { type DialogRender, dialogCore, type OpenDialogOptions } from "./dialog-core";

/** The prompt options that decide its frame; `size` and `surface` as in `DialogOptions`. */
type PromptFrame = { size?: string; surface?: string };

/**
 * On a phone a prompt rises from the bottom edge as a sheet, within thumb reach, with the sheet's own motion: it
 * slides in, follows the handle, and slides out. A full-screen or bare prompt keeps its own frame, and from 48rem
 * every prompt stays the dialog in the middle. The choice is made when the prompt opens.
 */
const opensAsSheet = (options?: PromptFrame): boolean =>
  options?.size !== "full" && options?.surface !== "bare" && typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches;

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

/**
 * Opens a prompt: the dialog in the middle, or on a phone the same content as a bottom sheet. Dismissing the sheet,
 * by its handle or a drag, takes the prompt's own dismiss path, as Escape does.
 */
export const openPrompt = <T,>(render: DialogRender<T>, options: OpenDialogOptions, prompt?: PromptFrame): Promise<T | undefined> => {
  if (!opensAsSheet(prompt)) return dialogCore.open<T>(render, options);
  return dialogCore.open<T>(
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
};
