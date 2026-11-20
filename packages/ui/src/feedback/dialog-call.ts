import { ringOnReturn } from "../internal/focus-return";
import type { readUiScope } from "../internal/portal-scope";

/**
 * What a dialog takes from its call: the page's disposal count, where focus returns, and the palette (read at once,
 * or later from the element that asked). A small module of its own, so a field that opens a dialog from code it loads
 * on demand (a date picker's phone sheet) reads its call without carrying the dialog core in its first script.
 */
export type DialogCall = {
  requested: number;
  /** The palette of the call, when it was read at once. */
  scope?: ReturnType<typeof readUiScope>;
  /** The element that asked: the palette is read from it when the dialog opens. */
  source?: Element;
  opener?: HTMLElement;
  openerRing: boolean;
};

/** Counts the page's island disposals: a dialog asked for before one opens over content it was never meant for. */
let disposals = 0;
export const notePageDisposal = (): void => {
  disposals += 1;
};
export const pageDisposals = (): number => disposals;

/** Reads the call now. A field passes its own element, whose palette the dialog takes even if focus moves away. */
export const readDialogCall = (source?: Element): DialogCall => {
  const opener = document.activeElement;
  return {
    requested: disposals,
    source,
    opener: opener instanceof HTMLElement ? opener : undefined,
    openerRing: ringOnReturn(opener),
  };
};
