import type { OpenDialogOptions } from "../feedback/dialog-core";

/** Initial focus goes to the first input of the top sheet, otherwise to the
 * dialog element itself. Native `showModal()` focuses the first focusable
 * descendant, which is the drag handle; iOS shows a ring for that programmatic
 * focus, so the sheet moves it to the ring-less dialog before the next paint. */
export const sheetInitialFocus = (dialog: HTMLDialogElement): HTMLElement => {
  const input = dialog.lastElementChild?.querySelector<HTMLElement>(
    "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role='combobox']:not([disabled]):not([aria-disabled='true'])",
  );
  if (input) return input;
  dialog.tabIndex = -1;
  return dialog;
};

// The options live apart from `BottomSheet`, so a module that only opens a sheet's dialog does not load the sheet's
// motion with them.
export const bottomSheetOptions = {
  panelClassName: "k2b-dialog k2b-bottom-sheet-frame",
  contentClassName: "k2b-panel-dialog-viewport k2b-bottom-sheet-viewport",
  initialFocus: sheetInitialFocus,
} satisfies OpenDialogOptions;

/** A sheet on phones and a centered dialog from 48rem up, for decisions and forms; menus keep
 * `bottomSheetOptions`. The stylesheet picks the mode with the phone media query, so the first
 * frame is already right and a rotation or resize switches it in place, without a remount. */
export const bottomSheetAdaptiveOptions = {
  ...bottomSheetOptions,
  panelClassName: `${bottomSheetOptions.panelClassName} is-adaptive`,
} satisfies OpenDialogOptions;
