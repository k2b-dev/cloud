import { PHONE_SHEET_QUERY } from "../actions/phone-sheet";
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

/**
 * Opens a prompt: the dialog in the middle, or on a phone the same content as a bottom sheet. The sheet's code loads
 * only then, so pages that never show a prompt on a phone do not carry it.
 */
export const openPrompt = <T,>(render: DialogRender<T>, options: OpenDialogOptions, prompt?: PromptFrame): Promise<T | undefined> =>
  opensAsSheet(prompt)
    ? import("./prompt-sheet-view").then((view) => view.openPromptSheet(render, options))
    : dialogCore.open<T>(render, options);
