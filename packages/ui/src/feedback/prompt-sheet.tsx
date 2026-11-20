import { PHONE_SHEET_QUERY } from "../actions/phone-sheet";
import { captureDialogOpen, type DialogCore, type DialogRender, type OpenDialogOptions } from "./dialog-core";

/** The prompt options that shape its dialog, as in `DialogOptions`. */
type PromptFrame = {
  size?: string;
  surface?: string;
  variant?: string;
  signal?: AbortSignal;
  cancelBehavior?: OpenDialogOptions["cancelBehavior"];
  history?: boolean;
  followContent?: boolean;
  ariaLabel?: string;
  title?: string;
};

/**
 * On a phone a prompt rises from the bottom edge as a sheet, within thumb reach, with the sheet's own motion: it
 * slides in, follows the handle, and slides out. A full-screen or bare prompt keeps its own frame, and from 48rem
 * every prompt stays the dialog in the middle. The choice is made when the prompt opens.
 */
const opensAsSheet = (options?: PromptFrame): boolean =>
  options?.size !== "full" && options?.surface !== "bare" && typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches;

export const panelClass = (options?: PromptFrame): string =>
  `k2b-dialog k2b-dialog--${options?.size ?? "medium"}${options?.variant && options.variant !== "primary" ? ` k2b-dialog--${options.variant}` : ""}${options?.surface === "bare" ? " is-bare" : ""}`;

export const contentClass = (surface?: string): string => (surface === "bare" ? "k2b-dialog__viewport is-bare" : "k2b-dialog__viewport");

type View = typeof import("./prompt-sheet-view");
let view: View | undefined;
const load = (): Promise<View> => import("./prompt-sheet-view").then((module) => (view = module));
// A phone loads the sheet's code in the background when prompts load, so the first prompt opens at once and in the
// order it was asked; a wider screen never loads it.
if (typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches) load().catch(() => {});

/**
 * Opens a prompt with the frame, cancellation, history, and name every prompt shares: the dialog in the middle, or on
 * a phone the same content as a bottom sheet. `label` names it when it has no title; `sheet: false` keeps the dialog.
 * A caller that loads code before it opens passes `open` from `captureDialogOpen()` at its own call; by default the
 * prompt takes its context here, before the sheet's code loads.
 */
export const openPrompt = <T,>(
  render: DialogRender<T>,
  options: PromptFrame | undefined,
  label: string,
  sheet = true,
  initialFocus?: OpenDialogOptions["initialFocus"],
  open: DialogCore["open"] = captureDialogOpen(),
): Promise<T | undefined> => {
  const frame: OpenDialogOptions = {
    panelClassName: panelClass(options),
    contentClassName: contentClass(options?.surface),
    initialFocus,
    signal: options?.signal,
    cancelBehavior: options?.cancelBehavior,
    history: options?.history,
    followContent: options?.followContent,
    ariaLabel: options?.ariaLabel ?? options?.title ?? label,
  };
  return !sheet || !opensAsSheet(options)
    ? open<T>(render, frame)
    : view
      ? view.openPromptSheet(render, frame, open)
      : load().then((module) => module.openPromptSheet(render, frame, open));
};
